/**
 * Host half of the Weiming HPC bundle: credentials check/setup, remote command
 * execution with password + TOTP, and a runtime skill describing the workflow.
 * Every tool checks the credentials file first and returns the acquisition steps
 * instead of attempting a login when the file is missing or unusable.
 */

import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  TARGETS,
  clusterOf,
  credentialsPath,
  describeCredentials,
  isKnownTarget,
  loadCredentials,
  readCredentialsFile,
  resolvedNode,
  writeCredentials,
} from './lib/config.js'
import { issueLines, setupGuidance } from './lib/guidance.js'
import { campusInterfaces, classifyNetwork, probeTcp } from './lib/network.js'
import { describeRuntime, sshReadiness } from './lib/platform.js'
import { BindingError, parseBindingText } from './lib/setup.js'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './lib/skill.js'
import { runRemoteCommand } from './lib/ssh.js'

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
  if (result.networkError) return 'unreachable'
  if (result.hostKeyFailed) return 'host-key'
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
    case 'unreachable':
      return '无法建立 SSH 连接：网络路径不可达（可能未连校园网/VPN、节点维护或本机防火墙）。'
    case 'host-key':
      return '主机密钥校验失败：目标主机不在 known_hosts 中，或记录的密钥与当前主机不一致。'
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
    case 'unreachable':
      return '先确认已连接北大校园网或学校 VPN（https://vpn.pku.edu.cn），再检查目标节点状态；不要反复重试同一节点。'
    case 'host-key':
      return '请在终端用 ssh 首次连接该节点并核对指纹（不要关闭 StrictHostKeyChecking）；若指纹变化，先通过可信渠道确认再更新 known_hosts。'
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
    runtime: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        platform: { type: 'string', required: true },
        ssh: { type: 'string', required: true },
        auth: { type: 'string', required: true, enum: ['askpass', 'unsupported'] },
        message: { type: 'string', required: true },
      },
    },
    network: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['unknown', 'reachable', 'off-campus', 'offline', 'dns', 'blocked'] },
        message: { type: 'string', required: true },
        nextStep: { type: 'string', required: true },
        localCampus: { type: 'boolean', required: true },
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
  lines.push(`运行环境：${value.runtime.platform} · ssh ${value.runtime.ssh === '' ? '未找到' : value.runtime.ssh} · ${value.runtime.auth === 'askpass' ? 'askpass 可用' : 'askpass 不可用'}`)
  if (value.runtime.message !== '') lines.push(clip(value.runtime.message, 600))
  lines.push('目标节点：')
  for (const target of value.targets) {
    const reach = target.reachable === 'reachable' ? '（22 端口可达）' : target.reachable === 'unreachable' ? '（22 端口不可达）' : ''
    const cluster = clusterOf(target.target)
    const label = cluster === '' ? '' : `[${cluster}] `
    lines.push(`  - ${label}${target.target} → ${target.user}@${target.host}${reach}`)
  }
  if (value.network.status !== 'unknown') {
    lines.push(`网络：${value.network.message}`)
    if (value.network.localCampus) lines.push('本机地址属于校园网段。')
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
    status: { type: 'string', required: true, enum: ['ok', 'setup-required', 'network-unavailable', 'auth-failed', 'host-key', 'timeout', 'aborted', 'unreachable', 'error'] },
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
  description: '检查未名 HPC 登录配置是否就绪：凭据文件、权限、TOTP 参数、目标节点（未名一号/二号/生科一号）、本机 ssh/askpass 支持情况；未配置时返回获取凭据的完整步骤。默认读取本地文件，probe=true 时额外检查校园网/VPN 与各节点 22 端口（并给出未连校园网或 VPN 的提示）。',
  parameters: {
    probe: { type: 'boolean', description: '是否执行网络预检：并行探测目标节点 22 端口，并判断当前是否在校园网/VPN 内（通常 3–5 秒），默认 false。' },
  },
  output: { schema: statusSchema, render: (_args, value) => text(renderStatus(value)) },
  async execute(args, exec) {
    const summary = describeCredentials(await loadCredentials())
    const runtime = describeRuntime()
    const issues = issueLines(summary.issues)
    let targets = summary.targets.map(target => ({ ...target, reachable: 'unknown' }))
    let network = {
      status: 'unknown',
      message: '未执行网络探测（probe=true 可检查校园网/VPN 与节点 22 端口）。',
      nextStep: '',
      localCampus: campusInterfaces().length > 0,
    }
    if (args.probe === true) {
      const classified = await classifyNetwork({
        hosts: summary.targets.map(target => ({ target: target.target, host: target.host })),
        signal: exec.signal,
      })
      targets = summary.targets.map(target => {
        const found = classified.hosts.find(entry => entry.target === target.target)
        const reachable = found?.state === 'open' ? 'reachable' : found?.state === 'aborted' ? 'unknown' : 'unreachable'
        return { ...target, reachable }
      })
      network = {
        status: classified.status,
        message: classified.message,
        nextStep: classified.nextStep,
        localCampus: classified.localCampus.length > 0,
      }
    }
    let nextStep
    if (!summary.configured) nextStep = setupGuidance(issues[0] ?? '凭据未就绪')
    else if (runtime.auth !== 'askpass') nextStep = runtime.message
    else if (network.status === 'unknown') nextStep = '配置已就绪：可直接调用 wm_server_run 执行远程命令；如需确认校园网/VPN，可用 probe=true 检查。'
    else if (network.status === 'reachable') nextStep = '配置与网络均已就绪：建议先用 hostname; whoami 验证登录。'
    else nextStep = network.nextStep
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
      runtime,
      network,
      nextStep,
    }
  },
})

/** Optional login check used by wm_server_setup after writing credentials. */
async function verifySetupLogin(path, config, target) {
  if (!isKnownTarget(config, target)) {
    return { verified: 'failed', verifyDetail: `未知节点：${target}；请检查 verifyTarget 或 nodes 配置。` }
  }
  try {
    const result = await runRemoteCommand({
      target,
      config,
      command: 'hostname; whoami',
      timeoutMs: 90_000,
      credentialsPath: path,
    })
    return {
      verified: result.exitCode === 0 ? 'ok' : 'failed',
      verifyDetail: clip((result.stdout + result.stderr).trim(), 1200) || `退出码 ${result.exitCode}`,
    }
  } catch (error) {
    return { verified: 'failed', verifyDetail: clip(error.message, 1200) }
  }
}

/** Shared success result for both the full and the account-only setup paths. */
function completedSetup({ path, account, summary, verified, verifyDetail, message }) {
  return setupResult({
    ok: true,
    written: true,
    credentialsPath: path,
    account,
    hasPassword: summary.passwordStored,
    totpAlgorithm: summary.totp?.algorithm ?? '',
    totpDigits: summary.totp?.digits ?? 0,
    totpPeriod: summary.totp?.period ?? 0,
    totpFingerprint: summary.totp?.fingerprint ?? '',
    verified,
    verifyDetail,
    message,
    nextStep: verified === 'ok'
      ? '登录验证通过，可以开始用 wm_server_run 执行远程命令。'
      : '可用 wm_server_status 复查配置，再用 wm_server_run 执行 hostname 验证登录。',
  })
}

const setupTool = defineTool({
  name: 'wm_server_setup',
  description: '写入未名 HPC 登录凭据。完整配置：提供扫码后复制的文字（otpauth://... 或 Base32 密钥）、HPC 登录密码和账号；校验后写入 ~/.config/weiming-hpc/credentials.json（权限 600）。只补账号：省略 bindingText，保留已有的密码与 TOTP 密钥，仅更新账号。账号为必填项，插件不内置默认账号。返回值只含密钥指纹，不含密码或密钥本身。',
  parameters: {
    bindingText: { type: 'string', description: '扫码后复制的文字，常见形式为 otpauth://totp/...?secret=...；也接受单独的 Base32 密钥或带“密钥：”标签的文字。省略时只更新账号，需要现有凭据里已有可用的密码和 TOTP 密钥。' },
    password: { type: 'string', description: 'HPC 登录密码；已保存过密码时可省略，省略且无既有密码时不写入。' },
    account: { type: 'string', required: true, description: 'HPC 账号（学号/工号），必填；插件不内置默认账号，也不会从绑定文字或旧配置里猜账号。' },
    verify: { type: 'boolean', description: '写入后是否立即执行一次 hostname 验证，默认 false；失败不会回滚已写入的凭据。' },
    verifyTarget: { type: 'string', description: 'verify=true 时使用的节点，默认 wm1-login；可改为 wm2-login、wmsk1-login 或自定义节点。' },
  },
  output: { schema: setupSchema, render: (_args, value) => text(renderSetup(value)) },
  async execute(args) {
    const path = credentialsPath()
    const existing = await loadCredentials()
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

    const bindingText = typeof args.bindingText === 'string' ? args.bindingText.trim() : ''
    if (bindingText === '') {
      const blocking = existing.issues.filter(issue => issue !== 'account')
      if (blocking.length > 0) {
        return setupResult({
          credentialsPath: path,
          account,
          message: `只更新账号需要已有的密码和 TOTP 密钥：${issueLines(blocking).join('；')}`,
          nextStep: '请提供扫码文字和密码完成完整配置，或先用 wm_server_status 修复凭据文件。',
        })
      }
      await writeCredentials(path, { ...(existing.config ?? {}), user: account })
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
        const verifyTarget = typeof args.verifyTarget === 'string' && args.verifyTarget.trim() !== '' ? args.verifyTarget.trim() : TARGETS[0]
        ({ verified, verifyDetail } = await verifySetupLogin(path, loaded.config, verifyTarget))
      }
      return completedSetup({
        path,
        account,
        summary,
        verified,
        verifyDetail,
        message: '账号已更新（保留原有密码和 TOTP 密钥）。',
      })
    }

    let parsed
    try {
      parsed = parseBindingText(bindingText)
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
      ...(existing.config ?? {}),
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
      const verifyTarget = typeof args.verifyTarget === 'string' && args.verifyTarget.trim() !== '' ? args.verifyTarget.trim() : TARGETS[0]
      ({ verified, verifyDetail } = await verifySetupLogin(path, loaded.config, verifyTarget))
    }
    return completedSetup({
      path,
      account,
      summary,
      verified,
      verifyDetail,
      message: '凭据已写入。',
    })
  },
})

const runTool = defineTool({
  name: 'wm_server_run',
  description: '在未名 HPC 指定节点执行远程 Bash 命令，自动完成密码 + TOTP 认证，返回 stdout、stderr 与退出码。未配置凭据时返回配置步骤，不尝试登录。执行前会探测目标节点 22 端口：不在校园网且未连学校 VPN 时直接返回提醒，不发起认证（可用 skipNetworkCheck 跳过）。data 节点可联网，login 节点用于提交和查询调度任务；重计算应提交 Slurm，不在登录节点直接运行。',
  parameters: {
    target: {
      type: 'string',
      required: true,
      description: '目标节点，必须显式选择。内置：wm1-login/wm1-data（未名一号）、wm2-login/wm2-data（未名二号）、wmsk1-login/wmsk1-data（未名生科一号）；也可使用凭据文件 nodes 里自定义的节点名。login 节点用于提交和查询作业，data 节点可联网传输。',
    },
    command: { type: 'string', required: true, description: '远程 Bash 命令；一次调用内保持 shell 状态，跨调用不保留。需要失败即停止时自行加 set -euo pipefail。' },
    timeoutSeconds: { type: 'number', description: '本地总超时秒数，默认 180，范围 5–900；超时只终止本地 ssh，不保证远程进程停止。' },
    skipNetworkCheck: { type: 'boolean', description: '跳过执行前的校园网/VPN 预检，直接尝试 SSH，默认 false。网络预检误报或使用特殊网络路径时可设为 true。' },
  },
  output: { schema: runSchema, render: (_args, value) => text(renderRun(value)) },
  async execute(args, exec) {
    const command = args.command.trim()
    if (command === '') throw new ToolArgsError(['invalid command: 期望非空字符串'])
    const seconds = Number.isFinite(args.timeoutSeconds) ? args.timeoutSeconds : 180
    const timeoutMs = Math.min(Math.max(seconds, 5), 900) * 1000
    const loaded = await loadCredentials()
    const path = loaded.path
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
    if (!isKnownTarget(loaded.config, args.target)) {
      return {
        status: 'error',
        target: args.target,
        address: '',
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        message: `未知节点：${args.target}。内置节点：${TARGETS.join('、')}。`,
        nextStep: '内置节点之外可在凭据文件的 nodes 里声明节点（键为节点名，值为 host/user），再作为 target 使用。',
      }
    }
    const node = resolvedNode(loaded.config, args.target)
    const address = `${node.user}@${node.host}`
    const readiness = sshReadiness()
    if (!readiness.ok) {
      return {
        status: 'error',
        target: args.target,
        address,
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        message: readiness.message,
        nextStep: '按上面的提示配置本机 ssh 客户端后重试；Windows 推荐安装 Git for Windows。',
      }
    }
    if (args.skipNetworkCheck !== true) {
      const state = await probeTcp(node.host, 22, 2_500, exec.signal)
      if (state === 'aborted') {
        return {
          status: 'aborted',
          target: args.target,
          address,
          exitCode: -1,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          message: '调用已取消；尚未发起 SSH 连接。',
          nextStep: '需要结果时重新执行。',
        }
      }
      if (state !== 'open') {
        const network = await classifyNetwork({ hosts: [{ target: args.target, host: node.host }], signal: exec.signal })
        return {
          status: 'network-unavailable',
          target: args.target,
          address,
          exitCode: -1,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          message: network.message,
          nextStep: network.nextStep,
        }
      }
    }
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
        nextStep: '检查本机 ssh 是否可用（macOS/Linux 为 /usr/bin/ssh；Windows 需 Git for Windows 的 ssh.exe），以及凭据文件是否完整。',
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
