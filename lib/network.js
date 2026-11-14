/**
 * Campus-network preflight for the Weiming cluster. The nodes only answer inside
 * the PKU campus network or an active school VPN, so an unreachable port is far
 * more often a network-path problem than a credentials problem. This module
 * distinguishes "not on campus network" from "no internet at all" and turns the
 * result into concrete guidance instead of a 20-second ssh timeout.
 */

import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'

/** PKU address ranges that identify a campus-local interface. */
const CAMPUS_PREFIXES = ['162.105.', '115.27.']

/** Default reachability probe used to tell "off campus" from "offline". */
export const INTERNET_PROBE = { host: 'www.pku.edu.cn', port: 443 }

/** Probe one TCP endpoint without throwing; resolves to a stable state string. */
export function probeTcp(host, port, timeoutMs = 2_500, signal) {
  return new Promise(resolve => {
    let socket = null
    let settled = false
    let timer = null
    const finish = state => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (socket !== null) {
        socket.removeAllListeners()
        socket.destroy()
      }
      resolve(state)
    }
    const onAbort = () => finish('aborted')
    if (signal?.aborted === true) {
      finish('aborted')
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    lookup(host)
      .then(() => {
        if (settled) return
        socket = connect({ host, port })
        socket.once('connect', () => finish('open'))
        socket.once('error', error => {
          finish(error?.code === 'ECONNREFUSED' ? 'refused' : 'timeout')
        })
      })
      .catch(() => finish('dns-error'))
  })
}

/** Local IPv4 interfaces whose address belongs to a campus range. */
export function campusInterfaces() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (CAMPUS_PREFIXES.some(prefix => entry.address.startsWith(prefix))) {
        found.push({ name, address: entry.address })
      }
    }
  }
  return found
}

/** Guidance text per classification; keeps the wording in one place. */
export const NETWORK_TEXT = {
  reachable: {
    message: '网络可达：未名集群的 SSH 端口可以连接。',
    nextStep: '',
  },
  'off-campus': {
    message: '无法连接未名集群的 SSH 端口（22），但公网可用：当前网络到校园网的路径可能被限制（校外或境外网络常见），或学校 VPN 未连接。',
    nextStep: '请连接北大校园网（PKU Secure/PKU 或校园有线），或学校 VPN（https://vpn.pku.edu.cn 全业务模式；pacvpn.pku.edu.cn 校园内网模式）后重试；已连接仍失败时确认目标节点未在维护；使用分流模式时确认 162.105.0.0/16 与 115.27.0.0/16 走 VPN。',
  },
  offline: {
    message: '本机无法访问公网，未名集群也不可达：请先恢复本机的网络连接。',
    nextStep: '检查 Wi-Fi/有线连接、代理或 DNS 设置后重试。',
  },
  dns: {
    message: '未名集群域名无法解析，但公网可用：可能是本机 DNS 或 VPN 的 DNS 配置问题。',
    nextStep: '检查 DNS 设置（或连接学校 VPN 后重试）；仍失败时把 wm_server_status 的输出发给管理员。',
  },
  blocked: {
    message: '本机地址看起来在校园网段内，但未名集群的 22 端口不可达：可能是节点维护、校园网策略或本机防火墙。',
    nextStep: '确认目标节点是否在线（可换一个节点或稍后重试），并检查本机防火墙是否放行 ssh；不要在登录节点上反复重试。',
  },
  unknown: {
    message: '未执行网络探测（probe=true 可检查校园网/VPN 与节点 22 端口）。',
    nextStep: '',
  },
}

/**
 * Classify connectivity to the given Weiming hosts.
 * `hosts` is `[{ target, host }]`; the result also lists each probe state so the
 * caller can annotate per-node reachability.
 */
export async function classifyNetwork({ hosts = [], port = 22, timeoutMs = 2_500, internet = INTERNET_PROBE, signal, localCampus = campusInterfaces() } = {}) {
  if (hosts.length === 0) {
    return { status: 'unknown', hosts: [], internet: null, localCampus, ...NETWORK_TEXT.unknown }
  }

  const results = await Promise.all(
    hosts.map(async entry => {
      const state = await probeTcp(entry.host, port, timeoutMs, signal)
      return { ...entry, state }
    }),
  )
  const reachable = results.filter(result => result.state === 'open')
  let status
  let internetState = null
  if (results.every(result => result.state === 'aborted')) {
    status = 'unknown'
  } else if (reachable.length > 0) {
    status = 'reachable'
  } else {
    internetState = await probeTcp(internet.host, internet.port, timeoutMs, signal)
    if (internetState !== 'open') {
      status = 'offline'
    } else if (results.every(result => result.state === 'dns-error')) {
      status = 'dns'
    } else if (localCampus.length > 0) {
      status = 'blocked'
    } else {
      status = 'off-campus'
    }
  }
  return {
    status,
    hosts: results,
    internet: { ...internet, state: internetState },
    localCampus,
    ...NETWORK_TEXT[status],
  }
}
