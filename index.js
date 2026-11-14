/**
 * Host half of the Weiming HPC bundle: credentials check/setup, remote command
 * execution with password + TOTP, and a runtime skill describing the workflow.
 * Every tool checks the credentials file first and returns the acquisition steps
 * instead of attempting a login when the file is missing or unusable.
 */

import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  TARGETS,
  credentialsPath,
  describeCredentials,
  readCredentialsFile,
  resolvedNode,
  writeCredentials,
} from './lib/config.js'
import { issueLines, setupGuidance } from './lib/guidance.js'
import { BindingError, parseBindingText } from './lib/setup.js'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './lib/skill.js'
import { probePort, runRemoteCommand } from './lib/ssh.js'

export const name = 'weiming-hpc'
export const inject = ['tools']

const ACCOUNT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u

function text(value) {
  return [{ type: 'text', text: value }]
}

function clip(value, limit = 4000) {
  const string = String(value ?? '')
  return string.length > limit ? `${string.slice(0, limit)}\n…[已截断 ${string.length - limit} 字符]` : string
}

function judge(result) {
  if (result.aborted) return 'aborted'
  if (result.timedOut) return 'timeout'
  if (result.authFailed) return 'auth-failed'
  return 'ok'
}

function remoteMessage(status, result, timeoutMs) {
  switch (status) {
    case 'auth-failed':
      return '认证失败：密码或动态口令不匹配，或 OTP 尚未完成绑定；本次每种凭据只提交了一次，未重试。'
    case 'timeout':
      return `本地超时（${Math.round(timeoutMs / 1000)} 秒）；远程进程可能仍在运行。`
    case 'aborted':
      return '调用已取消；远程进程可能仍在运行。'
    default:
      return result.exitCode === 0 ? '' : `远程命令返回退出码 ${result.exitCode}。`
  }
}

function remoteNextStep(status) {
  switch (status) {
    case 'auth-failed':
      return '先用 wm_server_status 复查配置与文件权限，确认密码和绑定状态后再最多重试一次，避免账号锁定。'
    case 'timeout':
      return '先确认远程是否已经产生结果，再决定是否重跑；不要盲目重复提交。'
    case 'aborted':
      return '需要结果时重新执行一次，并先确认上一次是否已生效。'
    case 'ok':
      return ''
    default:
      return ''
  }
}

/* ------------------------------------------------------------------ status */

const statusSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: { type: 'boolean', required: true },
    credentialsPath: { type: 'string', required: true },
    permissions: { type: 'string', required: true },
    account: { type: 'string', required: true },
    passwordStored: { type: 'boolean', required: true },
    totpAlgorithm: { type: 'string', required: true },
    totpDigits: { type: 'number', required: true },
    totpPeriod: { type: 'number', required: true },
    totpSecretLength: { type: 'number', required: true },
    totpFingerprint: { type: 'string', required: true },
    issues: { type: 'array', required: true, items: { type: 'string' } },
    targets: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          host: { type: 'string', required: true },
          user: { type: 'string', required: true },
          reachable: { type: 'string', required: true, enum: ['unknown', 'reachable', 'unreachable'] },
        },
      },
    },
    nextStep: { type: 'string', required: true },
  },
}

function renderStatus(value) {
  const lines = [value.configured ? '未名 HPC 登录配置：已就绪' : '未名 HPC 登录配置：未就绪']
  lines.push(`凭据文件：${value.credentialsPath}${value.permissions === '' ? '' : `（权限 ${value.permissions}）`}`)
  lines.push(`账号：${value.account}；密码：${value.passwordStored ? '已保存' : '未保存'}`)
  if (value.totpFingerprint !== '') {
    lines.push(`OTP：${value.totpAlgorithm}/${value.totpDigits} 位/${value.totpPeriod} 秒，密钥指纹 ${value.totpFingerprint}（Base32 长度 ${value.totpSecretLength}）`)
  }
  lines.push('目标节点：')
  for (const target of value.targets) {
    const reach = target.reachable === 'reachable' ? '（22 端口可达）' : target.reachable === 'unreachable' ? '（22 端口不可达）' : ''
    lines.push(`  - ${target.target} → ${target.user}@${target.host}${reach}`)
  }
  if (value.issues.length > 0) {
    lines.push('问题：')
    for (const issue of value.issues) lines.push(`  - ${issue}`)
  }
  lines.push('', value.nextStep)
  return lines.join('\n')
}

/* ------------------------------------------------------------------- setup */

const setupSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    written: { type: 'boolean', required: true },
    credentialsPath: { type: 'string', required: true },
    account: { type: 'string', required: true },
    hasPassword: { type: 'boolean', required: true },
    totpAlgorithm: { type: 'string', required: true },
    totpDigits: { type: 'number', required: true },
    totpPeriod: { type: 'number', required: true },
    totpFingerprint: { type: 'string', required: true },
    verified: { type: 'string', required: true, enum: ['not-requested', 'ok', 'failed'] },
    verifyDetail: { type: 'string', required: true },
    message: { type: 'string', required: true },
    nextStep: { type: 'string', required: true },
  },
}

function setupResult(overrides) {
  return {
    ok: false,
    written: false,
    credentialsPath: credentialsPath(),
    account: '',
    hasPassword: false,
    totpAlgorithm: '',
    totpDigits: 0,
    totpPeriod: 0,
    totpFingerprint: '',
    verified: 'not-requested',
    verifyDetail: '',
    message: '',
    nextStep: '',
    ...overrides,
  }
}

function renderSetup(value) {
  if (!value.ok) {
    return [`未写入凭据：${value.message}`, '', value.nextStep].join('\n')
  }
  const lines = [
    `已写入凭据：${value.credentialsPath}`,
    `账号：${value.account}；密码：${value.hasPassword ? '已写入' : '未保存'}`,
  ]
  if (value.totpFingerprint !== '') {
    lines.push(`OTP：${value.totpAlgorithm}/${value.totpDigits} 位/${value.totpPeriod} 秒，密钥指纹 ${value.totpFingerprint}`)
  }
  if (value.verified !== 'not-requested') {
    lines.push(`登录验证：${value.verified === 'ok' ? '通过' : '失败'}`)
    if (value.verifyDetail !== '') lines.push(clip(value.verifyDetail, 1200))
  }
  lines.push('', value.nextStep)
  return lines.join('\n')
}

/* --------------------------------------------------------------------- run */

const runSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['ok', 'setup-required', 'auth-failed', 'timeout', 'aborted', 'error'] },
    target: { type: 'string', required: true },
    address: { type: 'string', required: true },
    exitCode: { type: 'number', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    durationMs: { type: 'number', required: true },
    message: { type: 'string', required: true },
    nextStep: { type: 'string', required: true },
  },
}

function renderRun(value) {
  if (value.status === 'setup-required') return [value.message, '', value.nextStep].join('\n')
  const header = value.status === 'ok'
    ? `[${value.target}] ${value.address} · 退出码 ${value.exitCode} · ${(value.durationMs / 1000).toFixed(1)} 秒`
    : `[${value.target}] ${value.address} · ${value.status} · ${(value.durationMs / 1000).toFixed(1)} 秒`
  const lines = [header]
  if (value.stdout.trim() !== '') lines.push('--- stdout ---', value.stdout.replace(/\n+$/u, ''))
  if (value.stderr.trim() !== '') lines.push('--- stderr ---', value.stderr.replace(/\n+$/u, ''))
  if (value.truncated) lines.push('（输出过长，仅保留尾部）')
  if (value.message !== '') lines.push('', value.message)
  if (value.nextStep !== '') lines.push('', value.nextStep)
  return lines.join('\n')
}

/* ------------------------------------------------------------------- tools */

const statusTool = defineTool({
  name: 'wm_server_status',
  description: '检查未名 HPC（wm1/wm2）登录配置是否就绪：凭据文件、权限、TOTP 参数、目标节点；未配置时返回获取凭据的完整步骤。默认只读本地文件，probe=true 时额外探测各节点 22 端口。',
  parameters: {
    probe: { type: 'boolean', description: '是否探测每个目标节点的 SSH 端口可达性（每台约 3 秒），默认 false。' },
  },
  output: { schema: statusSchema, render: (_args, value) => text(renderStatus(value)) },
  async execute(args, exec) {
    const path = credentialsPath()
    const summary = describeCredentials(await readCredentialsFile(path))
    const targets = []
    for (const target of summary.targets) {
      let reachable = 'unknown'
      if (args.probe === true) {
        reachable = (await probePort(target.host, 22, 3000, exec.signal)) ? 'reachable' : 'unreachable'
      }
      targets.push({ ...target, reachable })
    }
    const issues = issueLines(summary.issues)
    return {
      configured: summary.configured,
      credentialsPath: summary.path,
      permissions: summary.permissions,
      account: summary.account,
      passwordStored: summary.passwordStored,
      totpAlgorithm: summary.totp?.algorithm ?? '',
      totpDigits: summary.totp?.digits ?? 0,
      totpPeriod: summary.totp?.period ?? 0,
      totpSecretLength: summary.totp?.secretLength ?? 0,
      totpFingerprint: summary.totp?.fingerprint ?? '',
      issues,
      targets,
      nextStep: summary.configured
        ? '配置已就绪：可直接调用 wm_server_run 执行远程命令，建议先用 hostname; whoami 验证。'
        : setupGuidance(issues[0] ?? '凭据未就绪'),
    }
  },
})

const setupTool = defineTool({
  name: 'wm_server_setup',
  description: '写入未名 HPC 登录凭据。输入用户在 HPC 动态口令页面用微信扫码后复制的文字（otpauth://... 或 Base32 密钥）、HPC 登录密码和账号；校验后写入 ~/.config/wm2/credentials.json（权限 600）。账号为必填项，插件不内置默认账号。返回值只含密钥指纹，不含密码或密钥本身。',
  parameters: {
    bindingText: { type: 'string', required: true, description: '扫码后复制的文字，常见形式为 otpauth://totp/...?secret=...；也接受单独的 Base32 密钥或带“密钥：”标签的文字。' },
    password: { type: 'string', description: 'HPC 登录密码；已保存过密码时可省略，省略且无既有密码时不写入。' },
    account: { type: 'string', required: true, description: 'HPC 账号（学号/工号），必填；插件不内置默认账号，也不会从绑定文字或旧配置里猜账号。' },
    verify: { type: 'boolean', description: '写入后是否立即在 wm2-data 执行一次 hostname 验证，默认 false；失败不会回滚已写入的凭据。' },
  },
  output: { schema: setupSchema, render: (_args, value) => text(renderSetup(value)) },
  async execute(args) {
    const path = credentialsPath()
    const existing = await readCredentialsFile(path)
    let parsed
    try {
      parsed = parseBindingText(args.bindingText)
    } catch (error) {
      if (error instanceof BindingError) {
        return setupResult({
          credentialsPath: path,
          message: `无法解析二维码文字：${error.message}`,
          nextStep: '请让用户重新扫码并复制完整文字；仍失败时可请用户把文字原样再发一次。',
        })
      }
      throw error
    }
    const account = typeof args.account === 'string' ? args.account.trim() : ''
    if (account === '') {
      return setupResult({
        credentialsPath: path,
        message: '缺少账号：插件不内置默认账号。',
        nextStep: '请让用户提供学号/工号，然后带上 account 重试；账号只写入本机 600 文件。',
      })
    }
    if (!ACCOUNT_PATTERN.test(account)) {
      return setupResult({ credentialsPath: path, message: `账号格式不合法：${account}`, nextStep: '请提供学号/工号形式的账号。' })
    }
    const storedPassword = typeof existing.config?.password === 'string' ? existing.config.password : ''
    const password = typeof args.password === 'string' && args.password.length > 0 ? args.password : storedPassword
    if (password === '') {
      return setupResult({
        credentialsPath: path,
        account,
        message: '还没有可用的 HPC 登录密码。',
        nextStep: '请让用户把 HPC 登录密码一起提供（只写入本机 600 文件，不会回显）；已有密码时可省略 password。',
      })
    }
    await writeCredentials(path, {
      totp_secret: parsed.totp_secret,
      digits: parsed.digits,
      period: parsed.period,
      algorithm: parsed.algorithm,
      user: account,
      password,
    })
    const loaded = await readCredentialsFile(path)
    if (!loaded.ok) {
      return setupResult({
        credentialsPath: path,
        account,
        message: `写入后校验失败：${issueLines(loaded.issues).join('；')}`,
        nextStep: '检查凭据文件的权限与内容后重试。',
      })
    }
    const summary = describeCredentials(loaded)
    let verified = 'not-requested'
    let verifyDetail = ''
    if (args.verify === true) {
      try {
        const result = await runRemoteCommand({
          target: 'wm2-data',
          config: loaded.config,
          command: 'hostname; whoami',
          timeoutMs: 90_000,
          credentialsPath: path,
        })
        verified = result.exitCode === 0 ? 'ok' : 'failed'
        verifyDetail = clip((result.stdout + result.stderr).trim(), 1200) || `退出码 ${result.exitCode}`
      } catch (error) {
        verified = 'failed'
        verifyDetail = clip(error.message, 1200)
      }
    }
    return setupResult({
      ok: true,
      written: true,
      credentialsPath: path,
      account,
      hasPassword: true,
      totpAlgorithm: summary.totp?.algorithm ?? '',
      totpDigits: summary.totp?.digits ?? 0,
      totpPeriod: summary.totp?.period ?? 0,
      totpFingerprint: summary.totp?.fingerprint ?? '',
      verified,
      verifyDetail,
      message: '凭据已写入。',
      nextStep: verified === 'ok'
        ? '登录验证通过，可以开始用 wm_server_run 执行远程命令。'
        : '可用 wm_server_status 复查配置，再用 wm_server_run 执行 hostname 验证登录。',
    })
  },
})

const runTool = defineTool({
  name: 'wm_server_run',
  description: '在未名 HPC 指定节点执行远程 Bash 命令，自动完成密码 + TOTP 认证，返回 stdout、stderr 与退出码。未配置凭据时返回配置步骤，不尝试登录。data 节点可联网，login 节点用于提交和查询调度任务；重计算应提交 Slurm，不在登录节点直接运行。',
  parameters: {
    target: {
      type: 'string',
      required: true,
      enum: TARGETS,
      description: '目标节点：wm1-data/wm2-data 用于下载与数据传输，wm1-login/wm2-login 用于提交和查询作业；必须显式选择。',
    },
    command: { type: 'string', required: true, description: '远程 Bash 命令；一次调用内保持 shell 状态，跨调用不保留。需要失败即停止时自行加 set -euo pipefail。' },
    timeoutSeconds: { type: 'number', description: '本地总超时秒数，默认 180，范围 5–900；超时只终止本地 ssh，不保证远程进程停止。' },
  },
  output: { schema: runSchema, render: (_args, value) => text(renderRun(value)) },
  async execute(args, exec) {
    const command = args.command.trim()
    if (command === '') throw new ToolArgsError(['invalid command: 期望非空字符串'])
    const seconds = Number.isFinite(args.timeoutSeconds) ? args.timeoutSeconds : 180
    const timeoutMs = Math.min(Math.max(seconds, 5), 900) * 1000
    const path = credentialsPath()
    const loaded = await readCredentialsFile(path)
    if (!loaded.ok) {
      const issues = issueLines(loaded.issues)
      return {
        status: 'setup-required',
        target: args.target,
        address: '',
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        message: setupGuidance(issues[0] ?? '凭据未就绪'),
        nextStep: '完成配置后再调用 wm_server_run。',
      }
    }
    const node = resolvedNode(loaded.config, args.target)
    const address = `${node.user}@${node.host}`
    try {
      const result = await runRemoteCommand({
        target: args.target,
        config: loaded.config,
        command,
        timeoutMs,
        credentialsPath: path,
        signal: exec.signal,
      })
      const status = judge(result)
      return {
        status,
        target: args.target,
        address: result.address,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        durationMs: result.durationMs,
        message: remoteMessage(status, result, timeoutMs),
        nextStep: remoteNextStep(status),
      }
    } catch (error) {
      return {
        status: 'error',
        target: args.target,
        address,
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        message: `无法发起 SSH 连接：${error.message}`,
        nextStep: '检查本机 /usr/bin/ssh 是否可用，以及凭据文件是否完整。',
      }
    }
  },
})

/* -------------------------------------------------------------------- apply */

export function apply(ctx) {
  ctx.tools.register(statusTool)
  ctx.tools.register(setupTool)
  ctx.tools.register(runTool)

  let skills
  try {
    skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  } catch {
    skills = undefined
  }
  if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
    ctx.effect(() => skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    }))
  }
}
