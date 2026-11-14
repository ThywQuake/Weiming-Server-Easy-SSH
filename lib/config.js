/** Credentials file handling for the Weiming HPC login (read, validate, merge, write). */

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CredentialError, decodeSecret, resolveTotpParams, secretFingerprint } from './totp.js'

/** Nodes the plugin can address; a target must be chosen explicitly. */
export const TARGETS = ['wm1-data', 'wm1-login', 'wm2-data', 'wm2-login']

/** Human-readable text for each issue code returned by `readCredentialsFile`. */
export const ISSUE_TEXT = {
  missing: '凭据文件不存在',
  permissions: '凭据文件权限过宽（需要 600）',
  owner: '凭据文件属主不是当前用户',
  parse: '凭据文件不是合法 JSON',
  password: '缺少登录密码',
  totp: '缺少或不合法的 TOTP 密钥',
  account: '缺少账号或账号格式不合法',
}

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u

/** Credentials path, overridable with `WM_HPC_CREDENTIALS` for tests and alternate setups. */
export function credentialsPath() {
  const override = process.env.WM_HPC_CREDENTIALS
  return override !== undefined && override.trim() !== ''
    ? override.trim()
    : join(homedir(), '.config', 'wm2', 'credentials.json')
}

/** Default SSH address for a target, matching the historical `<target>.pku.edu.cn` layout. */
export function targetAddress(target) {
  return `${target}.pku.edu.cn`
}

/**
 * Resolve the host and account for one target, honoring per-node overrides.
 * There is no built-in account: the credentials file must name one.
 */
export function resolvedNode(config, target) {
  const node = (config?.nodes ?? {})[target] ?? {}
  const host = typeof node.host === 'string' && HOST_PATTERN.test(node.host) ? node.host : targetAddress(target)
  const user = [node.user, config?.user].find(candidate => typeof candidate === 'string' && USER_PATTERN.test(candidate)) ?? ''
  return { host, user }
}

function describeMode(info) {
  if (info === null) return ''
  return (info.mode & 0o777).toString(8).padStart(3, '0')
}

/**
 * Read and validate the credentials file. Never returns an error for a missing or
 * malformed file: the caller reports the issues and the acquisition steps instead.
 */
export async function readCredentialsFile(path = credentialsPath()) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, path, issues: ['missing'], config: null, mode: '' }
    throw error
  }
  const issues = []
  let info = null
  try {
    info = await stat(path)
  } catch {
    info = null
  }
  if (info !== null && typeof process.getuid === 'function' && info.uid !== process.getuid()) issues.push('owner')
  if (info !== null && (info.mode & 0o077) !== 0) issues.push('permissions')
  let config = null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
    else issues.push('parse')
  } catch {
    issues.push('parse')
  }
  if (config !== null) {
    if (typeof config.password !== 'string' || config.password.length === 0) issues.push('password')
    try {
      if (typeof config.totp_secret !== 'string') throw new CredentialError('missing secret')
      decodeSecret(config.totp_secret)
      resolveTotpParams(config)
    } catch {
      issues.push('totp')
    }
    if (typeof config.user !== 'string' || !USER_PATTERN.test(config.user)) issues.push('account')
    for (const node of Object.values(config.nodes ?? {})) {
      if (node === null || typeof node !== 'object') continue
      if (node.user !== undefined && !USER_PATTERN.test(String(node.user))) issues.push('account')
    }
  }
  return { ok: issues.length === 0, path, issues, config, mode: describeMode(info) }
}

/** Secret-free projection of a credentials read, suitable for a tool result. */
export function describeCredentials(loaded) {
  const config = loaded.config ?? {}
  const { host: defaultHost, user: defaultUser } = resolvedNode(config, TARGETS[0])
  let totp = null
  try {
    const params = resolveTotpParams(config)
    const secret = decodeSecret(config.totp_secret)
    totp = {
      digits: params.digits,
      period: params.period,
      algorithm: params.algorithm,
      secretLength: String(config.totp_secret).replace(/\s+/gu, '').length,
      fingerprint: secretFingerprint(config.totp_secret),
    }
    void secret
  } catch {
    totp = null
  }
  return {
    configured: loaded.ok,
    path: loaded.path,
    permissions: loaded.mode,
    issues: loaded.issues.slice(),
    account: defaultUser,
    defaultHost,
    passwordStored: typeof config.password === 'string' && config.password.length > 0,
    totp,
    targets: TARGETS.map(target => {
      const node = resolvedNode(config, target)
      return { target, host: node.host, user: node.user, reachable: null }
    }),
  }
}

/**
 * Merge a patch into the credentials file and persist it atomically with mode 600.
 * Existing fields (including `nodes`) survive so a re-binding only replaces the OTP part.
 */
export async function writeCredentials(path, patch) {
  let existing = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
  } catch {
    existing = {}
  }
  const next = { ...existing, ...patch }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  return next
}
