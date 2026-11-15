import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  TARGETS,
  clusterOf,
  credentialsPath,
  isKnownTarget,
  loadCredentials,
  readCredentialsFile,
  resolvedNode,
  writeCredentials,
} from '../lib/config.js'
import { classifyNetwork, probeTcp } from '../lib/network.js'
import { resolveSsh, scratchBaseDirectory, sshReadiness, toPosixMountPath } from '../lib/platform.js'
import { BindingError, parseBindingText } from '../lib/setup.js'
import { classifySshFailure } from '../lib/ssh.js'
import { totpCode } from '../lib/totp.js'

function listen() {
  return new Promise(resolve => {
    const server = createServer(socket => socket.end())
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'wm-hpc-test-'))
}

test('RFC 6238 SHA-1 test vector', () => {
  assert.equal(
    totpCode({ totp_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 8, period: 30, algorithm: 'sha1' }, 59_000),
    '94287082',
  )
})

test('clusters and custom targets', () => {
  assert.ok(TARGETS.includes('wmsk1-login'))
  assert.ok(TARGETS.includes('wmsk1-data'))
  assert.equal(clusterOf('wmsk1-data'), '未名生科一号')
  assert.equal(clusterOf('wm2-login'), '未名二号')
  assert.equal(clusterOf('custom-node'), '')
  assert.equal(isKnownTarget({}, 'wmjx2-login'), false)
  assert.equal(isKnownTarget({ nodes: { 'wmjx2-login': { host: 'wmjx2-login.pku.edu.cn' } } }, 'wmjx2-login'), true)
  assert.equal(isKnownTarget({}, '../evil'), false)
})

test('legacy wm2 credentials migrate to the neutral path', async () => {
  const home = await temporaryDirectory()
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousOverride = process.env.WM_HPC_CREDENTIALS
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.WM_HPC_CREDENTIALS
  try {
    const legacy = join(home, '.config', 'wm2', 'credentials.json')
    await mkdir(dirname(legacy), { recursive: true, mode: 0o700 })
    await writeFile(legacy, JSON.stringify({
      password: 'secret',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      digits: 6,
      period: 30,
      algorithm: 'sha1',
      user: '2023000000',
    }), { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(legacy, 0o600)
    const loaded = await loadCredentials()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.path, join(home, '.config', 'weiming-hpc', 'credentials.json'))
    assert.equal(loaded.path, credentialsPath())
    if (process.platform !== 'win32') {
      assert.equal((await stat(loaded.path)).mode & 0o777, 0o600)
      assert.match(await readFile(legacy, 'utf8'), /totp_secret/u)
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousOverride === undefined) delete process.env.WM_HPC_CREDENTIALS
    else process.env.WM_HPC_CREDENTIALS = previousOverride
  }
})

test('binding text parsing', () => {
  const parsed = parseBindingText('otpauth://totp/PKU:2023000000?secret=JBSWY3DPEHPK3PXP&issuer=PKU&digits=6&period=30')
  assert.equal(parsed.totp_secret, 'JBSWY3DPEHPK3PXP')
  assert.equal(parsed.account, '2023000000')
  assert.throws(() => parseBindingText('not-a-binding'), BindingError)
})

test('credentials are written atomically with the account', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, '.config', 'wm2', 'credentials.json')
  await writeCredentials(path, {
    totp_secret: 'JBSWY3DPEHPK3PXP',
    digits: 6,
    period: 30,
    algorithm: 'sha1',
    user: '2023000000',
    password: 'secret',
  })
  const loaded = await readCredentialsFile(path)
  assert.deepEqual(loaded.issues, [])
  assert.equal(loaded.ok, true)
  assert.deepEqual(resolvedNode(loaded.config, 'wm1-data'), { host: 'wm1-data.pku.edu.cn', user: '2023000000' })
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  await writeCredentials(path, { totp_secret: 'KRSXG5CTMVRXEZLU' })
  const rebound = await readCredentialsFile(path)
  assert.equal(rebound.config.password, 'secret')
  assert.equal(rebound.config.user, '2023000000')
  assert.match(await readFile(path, 'utf8'), /"user": "2023000000"/u)
})

test('missing account is reported and never defaulted', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'credentials.json')
  await writeFile(path, JSON.stringify({ password: 'x', totp_secret: 'JBSWY3DPEHPK3PXP' }), { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
  assert.deepEqual((await readCredentialsFile(path)).issues, ['account'])
  assert.deepEqual(resolvedNode({}, 'wm2-login'), { host: 'wm2-login.pku.edu.cn', user: '' })
})

test('platform path mapping and ssh discovery', () => {
  assert.equal(toPosixMountPath('C:\\Program Files\\Git\\usr\\bin\\ssh.exe', 'msys'), '/c/Program Files/Git/usr/bin/ssh.exe')
  assert.equal(toPosixMountPath('D:\\tools\\askpass.sh', 'cygwin'), '/cygdrive/d/tools/askpass.sh')
  assert.equal(toPosixMountPath('/usr/bin/ssh', 'msys'), '/usr/bin/ssh')
  if (process.platform !== 'win32') assert.equal(scratchBaseDirectory(), tmpdir())
  const ssh = resolveSsh()
  if (process.platform === 'win32') {
    assert.notEqual(ssh.path, '')
    assert.ok(['msys', 'cygwin', 'native'].includes(ssh.kind))
  } else {
    assert.equal(ssh.path, '/usr/bin/ssh')
    assert.equal(ssh.kind, 'posix')
    assert.equal(sshReadiness().ok, true)
  }
})

test('tcp probe states', async t => {
  const { server, port } = await listen()
  t.after(() => close(server))
  assert.equal(await probeTcp('127.0.0.1', port, 2_000), 'open')
  const spare = await listen()
  const closedPort = spare.port
  await close(spare.server)
  assert.equal(await probeTcp('127.0.0.1', closedPort, 2_000), 'refused')
  assert.equal(await probeTcp('does-not-exist.invalid', 22, 2_000), 'dns-error')
})

test('campus network classification', async t => {
  const { server, port } = await listen()
  t.after(() => close(server))
  const closed = await listen()
  const closedPort = closed.port
  await close(closed.server)
  const internet = { host: '127.0.0.1', port }

  const reachable = await classifyNetwork({
    hosts: [{ target: 'wm2-login', host: '127.0.0.1' }],
    port,
    internet,
    localCampus: [],
  })
  assert.equal(reachable.status, 'reachable')

  const offCampus = await classifyNetwork({
    hosts: [{ target: 'wm2-login', host: '127.0.0.1' }],
    port: closedPort,
    internet,
    localCampus: [],
  })
  assert.equal(offCampus.status, 'off-campus')
  assert.match(offCampus.nextStep, /vpn\.pku\.edu\.cn/u)

  const offline = await classifyNetwork({
    hosts: [{ target: 'wm2-login', host: '127.0.0.1' }],
    port: closedPort,
    internet: { host: '127.0.0.1', port: closedPort },
    localCampus: [],
  })
  assert.equal(offline.status, 'offline')

  const dns = await classifyNetwork({
    hosts: [{ target: 'wm2-login', host: 'no-such-host.invalid' }],
    port: closedPort,
    internet,
    localCampus: [],
  })
  assert.equal(dns.status, 'dns')

  const blocked = await classifyNetwork({
    hosts: [{ target: 'wm2-login', host: '127.0.0.1' }],
    port: closedPort,
    internet,
    localCampus: [{ name: 'en0', address: '162.105.1.2' }],
  })
  assert.equal(blocked.status, 'blocked')
})

test('ssh failures are classified from stderr', () => {
  assert.deepEqual(
    classifySshFailure(255, 'ssh: connect to host wm2-login.pku.edu.cn port 22: Connection timed out\n'),
    { authFailed: false, networkError: true, hostKeyFailed: false },
  )
  assert.deepEqual(
    classifySshFailure(255, 'Permission denied (password,keyboard-interactive).\n'),
    { authFailed: true, networkError: false, hostKeyFailed: false },
  )
  assert.deepEqual(
    classifySshFailure(255, 'Host key verification failed.\n'),
    { authFailed: false, networkError: false, hostKeyFailed: true },
  )
  assert.deepEqual(classifySshFailure(0, ''), { authFailed: false, networkError: false, hostKeyFailed: false })
})
