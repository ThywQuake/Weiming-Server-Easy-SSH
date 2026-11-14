/**
 * SSH_ASKPASS helper: answer the password prompt and the TOTP verification prompt.
 * Runs as a separate process so no secret ever reaches SSH's command line or the
 * plugin's tool result. Each prompt kind is answered at most once per connection.
 */

import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { totpCode } from './totp.js'

function fail(message) {
  process.stderr.write(`wm-hpc askpass: ${message}\n`)
  process.exit(1)
}

function isSafeCredentialsFile(info) {
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false
  return (info.mode & 0o077) === 0
}

async function claim(stateDirectory, kind) {
  if (stateDirectory === undefined || stateDirectory === '') return true
  try {
    await writeFile(join(stateDirectory, `used-${kind}`), '1\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    return true
  }
  return true
}

const prompt = String(process.argv[2] ?? '')
const credentialsPath = process.env.WM_HPC_CREDENTIALS
if (credentialsPath === undefined || credentialsPath === '') fail('credentials path is not configured')

let config
try {
  const info = await stat(credentialsPath)
  if (!isSafeCredentialsFile(info)) fail('credentials file permissions or owner are unsafe')
  config = JSON.parse(await readFile(credentialsPath, 'utf8'))
} catch {
  fail('cannot read credentials')
}

let kind
if (/password|密码/iu.test(prompt)) kind = 'password'
else if (/verification|one[- ]time|passcode|otp|code|验证码|动态口令/iu.test(prompt)) kind = 'totp'
else fail('unrecognized prompt')

if (!(await claim(process.env.WM_HPC_STATE, kind))) {
  fail(`refusing to submit ${kind} twice; stop and verify the account state`)
}

if (kind === 'password') {
  const password = config.password
  if (typeof password !== 'string' || password.length === 0) fail('no password stored')
  if (/[\r\n]/u.test(password)) fail('stored password contains a newline')
  process.stdout.write(`${password}\n`)
  process.exit(0)
}

try {
  const period = Number.isInteger(config.period) ? config.period : 30
  const remaining = period - (Date.now() / 1000) % period
  if (remaining < 3) await new Promise(resolve => setTimeout(resolve, (remaining + 0.2) * 1000))
  process.stdout.write(`${totpCode(config)}\n`)
} catch {
  fail('cannot compute a TOTP code from the stored secret')
}
