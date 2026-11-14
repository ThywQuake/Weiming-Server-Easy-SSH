/** Model-facing guidance shown when credentials are missing or unusable. */

import { ISSUE_TEXT } from './config.js'

/** Ordered acquisition steps for a machine that has no usable credentials yet. */
export const SETUP_STEPS = [
  '打开未名 HPC 的动态口令（OTP）绑定页面（未名一号/二号信息门户中的“动态口令/OTP”入口），生成二维码。',
  '用微信扫描该二维码，复制识别出的文字（通常形如 otpauth://totp/...?secret=...）；扫码即完成绑定，若二维码过期请重新生成。',
  '把这段文字、HPC 登录密码和学号/工号一起发给 AI；插件不内置默认账号，缺账号时先向用户询问。',
  'AI 调用 wm_server_setup（bindingText=复制的文字，password=登录密码）解析并写入本机 ~/.config/wm2/credentials.json（权限 600，密钥与密码只落盘、不回显）。',
  '再调用 wm_server_status 确认 configured=true，最后用 wm_server_run 执行一次 hostname 验证登录。',
]

/** Multi-line setup instructions, optionally prefixed with the concrete reason. */
export function setupGuidance(reason) {
  const lines = []
  if (typeof reason === 'string' && reason.length > 0) lines.push(`原因：${reason}`)
  lines.push('获取登录配置的步骤：')
  SETUP_STEPS.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`)
  })
  lines.push('网络前提：未名集群并非所有网络都可直连；若工具提示 network-unavailable，先让用户连接校园网（PKU Secure/PKU 或校园有线）或学校 VPN（https://vpn.pku.edu.cn；或 pacvpn.pku.edu.cn），不要反复重试。')
  lines.push('注意：不要把密码或 OTP 密钥写进项目文件、脚本或版本库；工具返回值只包含密钥指纹。')
  return lines.join('\n')
}

/** Map issue codes to one readable line each. */
export function issueLines(issues) {
  return issues.map(code => ISSUE_TEXT[code] ?? code)
}
