/** Credentials file handling for the Weiming HPC login (read, validate, merge, write). */

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CredentialError, decodeSecret, resolveTotpParams, secretFingerprint } from './totp.js'

/**
 * Clusters of the PKU Weiming HPC platform and their shell-accessible nodes.
 * Addresses follow the official guide: https://hpc.pku.edu.cn/ug/guide/access/
 * Login nodes submit jobs, data nodes have internet access, and neither is
 * interchangeable with the other.
 */
export const CLUSTERS = [
  { prefix: 'wm1', name: '未名一号', targets: ['wm1-login', 'wm1-data'] },
  { prefix: 'wm2', name: '未名二号', targets: ['wm2-login', 'wm2-data'] },
  { prefix: 'wmsk1', name: '未名生科一号', targets: ['wmsk1-login', 'wmsk1-data'] },
]

/** Built-in nodes; a target must be one of these or declared in `nodes`. */
export const TARGETS = CLUSTERS.flatMap(cluster => cluster.targets)

/** Cluster display names keyed by target prefix. */
export const CLUSTER_NAMES = Object.fromEntries(CLUSTERS.map(cluster => [cluster.prefix, cluster.name]))

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
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** POSIX permission bits are meaningless on Windows, where NTFS ACLs apply. */
const POSIX_PERMISSIONS = process.platform !== 'win32'

/** Neutral credentials location; the old `wm2` directory is migrated on first use. */
export function credentialsPath() {
  const override = process.env.WM_HPC_CREDENTIALS
  return override !== undefined && override.trim() !== ''
    ? override.trim()
    : join(homedir(), '.config', 'weiming-hpc', 'credentials.json')
}

/** Legacy 0.1.x–0.2.x location, kept as a migration source. Empty when overridden. */
export function legacyCredentialsPath() {
  const override = process.env.WM_HPC_CREDENTIALS
  return override !== undefined && override.trim() !== ''
    ? ''
    : join(homedir(), '.config', 'wm2', 'credentials.json')
}

/** Cluster display name for a target such as `wmsk1-login`. */
export function clusterOf(target) {
  const prefix = String(target ?? '').split('-')[0]
  return CLUSTER_NAMES[prefix] ?? ''
}

/** True when the target is built in or declared under `nodes` in the credentials. */
export function isKnownTarget(config, target) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) return false
  if (TARGETS.includes(target)) return true
  const nodes = config?.nodes
  return nodes !== null && typeof nodes === 'object' && Object.prototype.hasOwnProperty.call(nodes, target)
}

/** Default SSH address for a target, matching the `<target>.pku.edu.cn` layout. */
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
  if (info === null || !POSIX_PERMISSIONS) return ''
  return (info.mode & 0o777).toString(8).padStart(3, '0')
}

async function fileExists(path) {
  if (path === '') return false
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Copy the legacy `~/.config/wm2/credentials.json` to the neutral path once.
 * The old file is kept as a backup; an existing neutral file is never replaced.
 */
export async function migrateLegacyCredentials() {
  const target = credentialsPath()
  const legacy = legacyCredentialsPath()
  if (legacy === '' || (await fileExists(target)) || !(await fileExists(legacy))) {
    return { migrated: false, path: target, legacyPath: legacy }
  }
  let text
  try {
    text = await readFile(legacy, 'utf8')
    JSON.parse(text)
  } catch {
    return { migrated: false, path: target, legacyPath: legacy }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await secure(temporary)
    await rename(temporary, target)
    await secure(target)
    return { migrated: true, path: target, legacyPath: legacy }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    return { migrated: false, path: target, legacyPath: legacy, error: error.message }
  }
}

/**
 * Read the active credentials. A successful legacy migration is preferred; when
 * migration is impossible the legacy file is still read so a working setup does
 * not disappear because of a permission problem in the new directory.
 */
export async function loadCredentials() {
  const override = process.env.WM_HPC_CREDENTIALS
  const overridden = override !== undefined && override.trim() !== ''
  if (!overridden) {
    await migrateLegacyCredentials().catch(() => {})
  }
  const path = credentialsPath()
  let loaded = await readCredentialsFile(path)
  if (!overridden && !loaded.ok && loaded.issues.length === 1 && loaded.issues[0] === 'missing') {
    const legacy = legacyCredentialsPath()
    if (await fileExists(legacy)) {
      const fallback = await readCredentialsFile(legacy)
      if (!fallback.issues.includes('missing')) loaded = { ...fallback, legacy: true }
    }
  }
  return loaded
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
  if (POSIX_PERMISSIONS && info !== null && typeof process.getuid === 'function' && info.uid !== process.getuid()) issues.push('owner')
  if (POSIX_PERMISSIONS && info !== null && (info.mode & 0o077) !== 0) issues.push('permissions')
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
  const customTargets = Object.keys(config.nodes ?? {}).filter(
    target => !TARGETS.includes(target) && TARGET_PATTERN.test(target),
  )
  return {
    configured: loaded.ok,
    path: loaded.path,
    permissions: loaded.mode,
    issues: loaded.issues.slice(),
    account: defaultUser,
    defaultHost,
    passwordStored: typeof config.password === 'string' && config.password.length > 0,
    totp,
    targets: [...TARGETS, ...customTargets].map(target => {
      const node = resolvedNode(config, target)
      return { target, host: node.host, user: node.user, reachable: null }
    }),
  }
}

/** Apply owner-only mode where POSIX modes exist; Windows inherits profile ACLs. */
async function secure(path) {
  if (!POSIX_PERMISSIONS) return
  await chmod(path, 0o600)
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
    await secure(temporary)
    await rename(temporary, path)
    await secure(path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  return next
}
