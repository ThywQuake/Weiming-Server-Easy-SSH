/** SSH transport: password + TOTP through an askpass helper, no pty, bounded output. */

import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvedNode } from './config.js'
import { normalizeSecret, resolveTotpParams } from './totp.js'

const ASKPASS_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'askpass.mjs')
const TAIL_LIMIT = 120_000
const AUTH_FAILURE = /(?:permission denied|authentication failed|too many authentication failures|please try again)/iu

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

/** Run one remote Bash login command on a target and return its bounded output. */
export async function runRemoteCommand({ target, config, command, timeoutMs = 180_000, credentialsPath, signal }) {
  const { host, user } = resolvedNode(config, target)
  const address = `${user}@${host}`
  if (!normalizeSecret(config.totp_secret)) throw new Error('credentials have no usable TOTP secret')
  resolveTotpParams(config)
  if (typeof config.password !== 'string' || config.password.length === 0) throw new Error('credentials have no password')

  const directory = await mkdtemp(join(tmpdir(), 'dsh-wm-hpc-'))
  const askpassPath = join(directory, 'askpass')
  const stdout = createTail()
  const stderr = createTail()
  let child = null
  let timedOut = false
  let aborted = false
  const started = Date.now()
  try {
    const shim = [
      '#!/bin/sh',
      `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(ASKPASS_HELPER)} "$@"`,
      '',
    ].join('\n')
    await writeFile(askpassPath, shim, { mode: 0o700 })
    await chmod(askpassPath, 0o700)

    const environment = {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: '',
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
    child = spawn('/usr/bin/ssh', args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })

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
      authFailed: exitCode === 255 && AUTH_FAILURE.test(err.text),
      durationMs: Date.now() - started,
    }
  } finally {
    if (child !== null && child.exitCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** Best-effort TCP reachability probe for a host and port; never throws. */
export function probePort(host, port, timeoutMs = 3_000, signal) {
  return new Promise(resolve => {
    let settled = false
    const socket = connect({ host, port })
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const onAbort = () => finish(false)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    if (signal?.aborted === true) {
      finish(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
