/** RFC 6238 TOTP helpers shared by the plugin, the setup flow, and the askpass helper. */

import { createHash, createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ALGORITHMS = new Set(['sha1', 'sha256', 'sha512'])

/** An expected validation failure with a stable code and a user-readable message. */
export class CredentialError extends Error {
  constructor(message, code = 'invalid-credential') {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/** Normalize a Base32 secret copied from a QR binding page and reject unusable values. */
export function normalizeSecret(input) {
  if (typeof input !== 'string') throw new CredentialError('TOTP 密钥必须是字符串')
  const compact = input.replace(/[\s-]/g, '').replace(/=+$/u, '').toUpperCase()
  if (compact.length === 0) throw new CredentialError('TOTP 密钥为空')
  for (const character of compact) {
    if (!BASE32_ALPHABET.includes(character)) {
      throw new CredentialError('TOTP 密钥不是合法的 Base32 字符串（只允许 A–Z 与 2–7）')
    }
  }
  if (compact.length < 16) throw new CredentialError('TOTP 密钥过短：Base32 至少 16 位（80 位随机数）')
  return compact
}

/** Decode a Base32 secret into the HMAC key bytes. */
export function decodeSecret(input) {
  const compact = normalizeSecret(input)
  let bits = 0
  let value = 0
  const output = []
  for (const character of compact) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((value >>> bits) & 0xff)
    }
  }
  if (output.length < 10) throw new CredentialError('TOTP 密钥解码后过短')
  return Buffer.from(output)
}

/** Resolve and validate the TOTP parameters, defaulting to the usual 6/30/SHA-1. */
export function resolveTotpParams(source = {}) {
  const digits = source.digits ?? 6
  const period = source.period ?? 30
  const rawAlgorithm = String(source.algorithm ?? 'sha1').toLowerCase().replaceAll('-', '')
  if (digits !== 6 && digits !== 8) throw new CredentialError('TOTP digits 只能是 6 或 8')
  if (!Number.isInteger(period) || period <= 0 || period > 300) {
    throw new CredentialError('TOTP period 必须是 1–300 之间的整数秒')
  }
  if (!ALGORITHMS.has(rawAlgorithm)) throw new CredentialError('TOTP algorithm 仅支持 sha1、sha256、sha512')
  return { digits, period, algorithm: rawAlgorithm }
}

/** Current TOTP code for the configured secret and parameters. */
export function totpCode(source, nowMs = Date.now()) {
  const { digits, period, algorithm } = resolveTotpParams(source)
  const key = decodeSecret(source.totp_secret ?? source.secret)
  const counter = Math.floor(nowMs / 1000 / period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac(algorithm, key).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(value).padStart(digits, '0')
}

/** Stable short fingerprint that identifies a secret without revealing it. */
export function secretFingerprint(input) {
  return createHash('sha256').update(decodeSecret(input)).digest('hex').slice(0, 8)
}
