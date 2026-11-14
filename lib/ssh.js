/** SSH transport: password + TOTP through an askpass helper, no pty, bounded output. */

import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvedNode } from './config.js'
import { scratchBaseDirectory, sshReadiness, toPosixMountPath } from './platform.js'
import { normalizeSecret, resolveTotpParams } from './totp.js'

const ASKPASS_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'askpass.mjs')
const TAIL_LIMIT = 120_000
const AUTH_FAILURE = /(?:permission denied|authentication failed|too many authentication failures|please try again)/iu
const NETWORK_FAILURE = /(?:connection (?:timed out|refused|closed)|no route to host|network is unreachable|could not resolve hostname|connection reset by peer|broken pipe|operation timed out)/iu
const HOST_KEY_FAILURE = /(?:host key verification failed|remote host identification has changed|no [a-z0-9-]+ host key is known)/iu

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function createTail() {
  let buffer = ''
  let dropped = false
  return {
    push(chunk) {
      buffer += chunk
      if (buffer.length > TAIL_LIMIT) {
        buffer = buffer.slice(-TAIL_LIMIT)
        dropped = true
      }
    },
    read() {
      return { text: buffer, truncated: dropped }
    },
  }
}

/**
 * Write the askpass shim. POSIX shells run it directly; MSYS2/Cygwin need the
 * script to be named `/bin/sh`-compatible and invoked through their mount
 * namespace, so the Windows paths are rewritten to `/c/...` (or `/cygdrive/c/...`).
 */
async function writeAskpass(directory, ssh) {
  if (ssh.kind === 'posix') {
    const file = join(directory, 'askpass')
    const shim = [
      '#!/bin/sh',
      `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(ASKPASS_HELPER)} "$@"`,
      '',
    ].join('\n')
    await writeFile(file, shim, { mode: 0o700 })
    await chmod(file, 0o700)
    return { file, environment: file }
  }
  const file = join(directory, 'askpass.sh')
  const node = toPosixMountPath(process.execPath, ssh.kind)
  const helper = toPosixMountPath(ASKPASS_HELPER, ssh.kind)
  const shim = [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(node)} ${shellQuote(helper)} "$@"`,
    '',
  ].join('\n')
  await writeFile(file, shim, { mode: 0o700 })
  await chmod(file, 0o700).catch(() => {})
  return { file, environment: toPosixMountPath(file, ssh.kind) }
}

/** Classify an ssh exit status from its stderr without touching the transport. */
export function classifySshFailure(exitCode, stderr) {
  return {
    authFailed: exitCode === 255 && AUTH_FAILURE.test(stderr),
    networkError: exitCode === 255 && NETWORK_FAILURE.test(stderr),
    hostKeyFailed: exitCode === 255 && HOST_KEY_FAILURE.test(stderr),
  }
}

/** Run one remote Bash login command on a target and return its bounded output. */
export async function runRemoteCommand({ target, config, command, timeoutMs = 180_000, credentialsPath, signal }) {
  const { host, user } = resolvedNode(config, target)
  const address = `${user}@${host}`
  if (!normalizeSecret(config.totp_secret)) throw new Error('credentials have no usable TOTP secret')
  resolveTotpParams(config)
  if (typeof config.password !== 'string' || config.password.length === 0) throw new Error('credentials have no password')

  const readiness = sshReadiness()
  if (!readiness.ok) throw new Error(readiness.message)

  let directory
  try {
    directory = await mkdtemp(join(scratchBaseDirectory(), 'dsh-wm-hpc-'))
  } catch {
    directory = await mkdtemp(join(tmpdir(), 'dsh-wm-hpc-'))
  }
  const stdout = createTail()
  const stderr = createTail()
  let child = null
  let timedOut = false
  let aborted = false
  const started = Date.now()
  try {
    const askpass = await writeAskpass(directory, readiness.ssh)

    const environment = {
      ...process.env,
      SSH_ASKPASS: askpass.environment,
      SSH_ASKPASS_REQUIRE: 'force',
      // A non-empty DISPLAY lets pre-8.4 OpenSSH clients fall back to askpass
      // when they ignore SSH_ASKPASS_REQUIRE; ssh itself never opens a display.
      DISPLAY: 'dsh-wm-hpc:0',
      WM_HPC_CREDENTIALS: credentialsPath,
      WM_HPC_STATE: directory,
    }
    delete environment.SSH_AUTH_SOCK

    const args = [
      '-T',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'PreferredAuthentications=keyboard-interactive,password',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      address,
      `exec bash -lc ${shellQuote(command)}`,
    ]
    child = spawn(readiness.ssh.path, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 255))
    })
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)

    const out = stdout.read()
    const err = stderr.read()
    const failure = classifySshFailure(exitCode, err.text)
    return {
      host,
      user,
      address,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      timedOut,
      aborted,
      ...failure,
      durationMs: Date.now() - started,
    }
  } finally {
    if (child !== null && child.exitCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
