/**
 * Host platform capabilities: locate a usable `ssh` client and decide how a
 * password/TOTP answer can be delivered without an interactive terminal.
 *
 * macOS and Linux use the system OpenSSH plus a POSIX `SSH_ASKPASS` shell shim.
 * Windows needs an MSYS2/Cygwin build of OpenSSH for the same trick: Microsoft's
 * Win32-OpenSSH cannot execute a shell-script askpass helper, so it cannot be
 * driven unattended here. `WM_HPC_SSH` points the plugin at another client and
 * `WM_HPC_SSH_KIND` (posix|msys|cygwin) overrides the detected flavor.
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Node platform string (`darwin`, `win32`, `linux`, ...). */
export const PLATFORM = process.platform

/** True on Windows, where OpenSSH flavors differ in askpass support. */
export const IS_WINDOWS = PLATFORM === 'win32'

const KINDS = new Set(['posix', 'msys', 'cygwin', 'native'])

function exists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function normalize(path) {
  return path.replaceAll('\\', '/').toLowerCase()
}

/** Classify an ssh binary by its path; unknown POSIX boxes are treated as POSIX. */
function classify(path) {
  const value = normalize(path)
  if (value.includes('/git/usr/bin/ssh')) return 'msys'
  if (/(^|\/)cygwin(64)?\//u.test(value)) return 'cygwin'
  if (value.includes('/system32/openssh/') || value.includes('/windows/system32/')) return 'native'
  return IS_WINDOWS ? 'native' : 'posix'
}

/**
 * Base directory for the short-lived askpass shim. On Windows the path must be
 * ASCII and free of spaces: the MSYS ssh client fails to start an askpass helper
 * whose path contains spaces, and non-ASCII paths are a known CreateProcess trap.
 * `%PUBLIC%` (C:\\Users\\Public) is ASCII, space-free and writable by users.
 */
export function scratchBaseDirectory() {
  const preferred = tmpdir()
  if (!IS_WINDOWS) return preferred
  const usable = value => value !== '' && !value.includes(' ') && /^[\x20-\x7e]+$/u.test(value)
  if (usable(preferred)) return preferred
  for (const candidate of [process.env.PUBLIC, process.env.ProgramData]) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    if (usable(value) && exists(value)) return value
  }
  return preferred
}

/** Windows candidates in preference order: Git/MSYS2 first, then the inbox client. */
function windowsCandidates() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(programFiles, 'Git', 'usr', 'bin', 'ssh.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'ssh.exe'),
  ]
  if (localAppData !== '') candidates.push(join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'ssh.exe'))
  candidates.push(join(windir, 'System32', 'OpenSSH', 'ssh.exe'), 'ssh')
  return candidates
}

/** POSIX candidates: the system path plus the conventional Homebrew/usr-local one. */
function posixCandidates() {
  return ['/usr/bin/ssh', '/usr/local/bin/ssh', 'ssh']
}

/**
 * Convert a Windows path to the form expected by the given MSYS/Cygwin flavor.
 * MSYS2 mounts drives at `/c`, Cygwin at `/cygdrive/c`.
 */
export function toPosixMountPath(path, kind = 'msys') {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path)
  if (match === null) return path.replaceAll('\\', '/')
  const drive = match[1].toLowerCase()
  const rest = match[2].replaceAll('\\', '/')
  return kind === 'cygwin' ? `/cygdrive/${drive}/${rest}` : `/${drive}/${rest}`
}

/** Resolve the ssh client to use, honoring `WM_HPC_SSH` and `WM_HPC_SSH_KIND`. */
export function resolveSsh() {
  const override = (process.env.WM_HPC_SSH ?? '').trim()
  if (override !== '') {
    const forced = (process.env.WM_HPC_SSH_KIND ?? '').trim().toLowerCase()
    const kind = KINDS.has(forced) ? forced : classify(override)
    return { path: override, kind, source: 'WM_HPC_SSH', available: override === 'ssh' || exists(override) }
  }
  const candidates = IS_WINDOWS ? windowsCandidates() : posixCandidates()
  for (const candidate of candidates) {
    if (candidate === 'ssh' || exists(candidate)) {
      return { path: candidate, kind: classify(candidate), source: 'auto', available: true }
    }
  }
  return { path: '', kind: 'missing', source: 'auto', available: false }
}

/** True when a shell-script askpass helper can be spawned by this ssh flavor. */
export function supportsAskpass(kind) {
  return kind === 'posix' || kind === 'msys' || kind === 'cygwin'
}

/**
 * Human-readable readiness of the local SSH client. `ok: false` carries an
 * actionable message instead of letting a login fail with a bare spawn error.
 */
export function sshReadiness() {
  const ssh = resolveSsh()
  if (ssh.path === '' || !ssh.available) {
    return {
      ok: false,
      ssh,
      message: IS_WINDOWS
        ? '找不到可用的 ssh.exe：请安装 Git for Windows（推荐），或启用 Windows 的 OpenSSH 客户端。'
        : '找不到可用的 ssh：macOS 自带 /usr/bin/ssh，Linux 请安装 openssh-client。',
    }
  }
  if (!supportsAskpass(ssh.kind)) {
    return {
      ok: false,
      ssh,
      message: `Windows 自带的 ${ssh.path} 不能运行脚本式 askpass，无法完成无人值守的密码 + 动态口令登录。请安装 Git for Windows 后重试（优先使用 C:\\Program Files\\Git\\usr\\bin\\ssh.exe），或用 WM_HPC_SSH 指向 Git/MSYS2/Cygwin 的 ssh.exe。`,
    }
  }
  return { ok: true, ssh, message: '' }
}

/** Short description of the local runtime for tool output. */
export function describeRuntime() {
  const readiness = sshReadiness()
  return {
    platform: PLATFORM,
    ssh: readiness.ssh.path,
    auth: readiness.ok ? 'askpass' : 'unsupported',
    message: readiness.ok ? '' : readiness.message,
  }
}
