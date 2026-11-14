/** Parse the text a user copies after scanning the HPC one-time-password QR code. */

import { CredentialError, normalizeSecret, resolveTotpParams } from './totp.js'

/** An expected failure while interpreting the pasted binding text. */
export class BindingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BindingError'
    this.code = 'invalid-binding-text'
  }
}

const ACCOUNT_PATTERN = /(?<!\d)(\d{8,12})(?!\d)/u

function findAccount(text) {
  const match = ACCOUNT_PATTERN.exec(text ?? '')
  return match === null ? undefined : match[1]
}

function fromUri(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new BindingError('otpauth 链接格式不正确，无法解析')
  }
  if (url.protocol !== 'otpauth:') throw new BindingError('只支持 otpauth:// 开头的绑定链接')
  const secret = url.searchParams.get('secret')
  if (secret === null || secret === '') throw new BindingError('otpauth 链接里没有 secret 参数')
  const label = decodeURIComponent(url.pathname.replace(/^\/+/u, ''))
  const labelAccount = label.includes(':') ? label.slice(label.lastIndexOf(':') + 1).trim() : label.trim()
  const digits = url.searchParams.get('digits')
  const period = url.searchParams.get('period')
  const algorithm = url.searchParams.get('algorithm')
  const parsed = {
    totp_secret: normalizeSecret(secret),
    digits: digits === null ? 6 : Number(digits),
    period: period === null ? 30 : Number(period),
    algorithm: algorithm === null ? 'sha1' : algorithm.toLowerCase(),
  }
  try {
    resolveTotpParams(parsed)
  } catch (error) {
    throw new BindingError(error instanceof CredentialError ? error.message : '绑定链接中的 TOTP 参数不合法')
  }
  const account = /^\d{6,12}$/u.test(labelAccount) ? labelAccount : findAccount(label)
  const issuer = url.searchParams.get('issuer')
  return issuer === null ? { ...parsed, account } : { ...parsed, account, issuer }
}

function fromLabeledText(text) {
  const labeled = /(?:secret|key|密钥|动态口令密钥)\s*[:：=]\s*([A-Za-z2-7][A-Za-z2-7\s=]{15,})/iu.exec(text)
  const inline = /[?&\s]secret\s*=\s*([A-Za-z2-7]+=*)/iu.exec(text)
  const candidate = labeled?.[1] ?? inline?.[1]
  if (candidate === undefined) return undefined
  const normalized = normalizeSecret(candidate)
  return { totp_secret: normalized, digits: 6, period: 30, algorithm: 'sha1', account: findAccount(text) }
}

/**
 * Interpret the pasted text as an otpauth URI, a labeled secret line, a `secret=`
 * parameter, or a bare Base32 secret. Returns normalized TOTP fields plus an
 * optional account, and never echoes the secret back in an error.
 */
export function parseBindingText(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) throw new BindingError('没有收到二维码文字；请先扫码并复制识别出的文字')

  const uri = /otpauth:\/\/\S+/iu.exec(text)
  if (uri !== null) return fromUri(uri[0])

  const labeled = fromLabeledText(text)
  if (labeled !== undefined) return labeled

  const compact = text.replace(/[\s=]/gu, '')
  if (/^[A-Za-z2-7]+$/u.test(compact) && compact.length >= 16) {
    return {
      totp_secret: normalizeSecret(compact),
      digits: 6,
      period: 30,
      algorithm: 'sha1',
      account: findAccount(text),
    }
  }
  throw new BindingError('无法从这段文字识别出 OTP 密钥；请重新扫码并复制完整文字（通常以 otpauth:// 开头）')
}
