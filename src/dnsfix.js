/**
 * 解析层兜底。
 *
 * 为什么需要：`node:https` 默认走 `dns.lookup()`，也就是交给系统解析器
 * （Windows 上是 `getaddrinfo`，实际问的是路由器/运营商 DNS）。家用路由器
 * 的 dnsmasq 在并发一高、或上游 UDP 丢包时会直接回 NXDOMAIN，Node 收到
 * 的就是 `getaddrinfo ENOTFOUND`——域名其实是好的，只是这一秒没人答上来。
 *
 * 这里给 `https.request` 挂一个自定义 `lookup`：
 *   1. 自带缓存（命中不发包）
 *   2. 直接问公共 DNS（c-ares，绕过 getaddrinfo）
 *   3. 公共 DNS 全挂才回落系统解析器
 *
 * @module src/dnsfix.js
 */

import dns from 'node:dns'
import net from 'node:net'

/** 公共解析器，按顺序全试一遍。 */
export const DNS_SERVERS = Object.freeze(['223.5.5.5', '119.29.29.29', '114.114.114.114', '180.76.76.76'])

/** 正结果缓存时长。 */
export const DNS_CACHE_TTL_MS = 120_000
/** 失败结果短缓存，避免同一轮里反复打。 */
const NEGATIVE_TTL_MS = 3_000
const QUERY_TIMEOUT_MS = 2_500

/** @type {Map<string, {addresses: string[], expires: number}>} */
const cache = new Map()

const resolver = new dns.promises.Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 })
resolver.setServers([...DNS_SERVERS])

function remember(host, addresses) {
  cache.set(host, {
    addresses,
    expires: Date.now() + (addresses.length > 0 ? DNS_CACHE_TTL_MS : NEGATIVE_TTL_MS),
  })
}

function recall(host) {
  const hit = cache.get(host)
  if (hit === undefined) return undefined
  if (hit.expires <= Date.now()) {
    cache.delete(host)
    return undefined
  }
  return hit.addresses
}

async function viaPublicDns(host) {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  const addresses = []
  if (v4.status === 'fulfilled') addresses.push(...v4.value)
  if (v6.status === 'fulfilled') addresses.push(...v6.value)
  return addresses
}

async function viaSystemDns(host) {
  const list = await dns.promises.lookup(host, { all: true, verbatim: true })
  return list.map(item => item.address)
}

/** DoH 端点：UDP 53 被封、或路由器连查询都不答时，走 443 上的 HTTPS 解析。 */
export const DOH_ENDPOINTS = Object.freeze([
  'https://223.5.5.5/resolve',
  'https://doh.pub/dns-query',
  'https://dns.alidns.com/resolve',
])

async function viaDoh(host) {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`
      const response = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const payload = await response.json()
      const rows = Array.isArray(payload?.Answer) ? payload.Answer : []
      const addresses = rows
        .filter(row => Number(row?.type) === 1 || Number(row?.type) === 28)
        .map(row => String(row?.data ?? '').trim())
        .filter(address => net.isIP(address) !== 0)
      if (addresses.length > 0) return addresses
    } catch {
      continue
    }
  }
  return []
}

/**
 * 解析主机名：缓存 → 公共 DNS(UDP) → DoH(443) → 系统解析器。
 * 四层依次兜底，任意一层拿到地址就返回。
 * @param {string} host
 * @returns {Promise<string[]>}
 */
export async function resolveHost(host) {
  if (net.isIP(host) !== 0) return [host]
  const cached = recall(host)
  if (cached !== undefined) return cached

  let addresses = []
  try {
    addresses = await viaPublicDns(host)
  } catch {
    addresses = []
  }
  if (addresses.length === 0) {
    try {
      addresses = await viaDoh(host)
    } catch {
      addresses = []
    }
  }
  if (addresses.length === 0) {
    try {
      addresses = await viaSystemDns(host)
    } catch {
      addresses = []
    }
  }
  remember(host, addresses)
  return addresses
}

/**
 * 给 `http(s).request` 用的 lookup 实现，签名对齐 `net.connect`。
 * @param {string} hostname
 * @param {number | {family?: number, all?: boolean}} options
 * @param {(error: Error | null, address?: string | Array<{address: string, family: number}>, family?: number) => void} callback
 */
export function pinnedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : options ?? {}
  const wantAll = opts.all === true
  const family = typeof opts.family === 'number' ? opts.family : 0

  resolveHost(hostname)
    .then(addresses => {
      const filtered = family === 0 ? addresses : addresses.filter(address => net.isIP(address) === family)
      if (filtered.length === 0) {
        const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
        error.code = 'ENOTFOUND'
        error.errno = -3008
        error.hostname = hostname
        callback(error)
        return
      }
      if (wantAll) {
        callback(null, filtered.map(address => ({ address, family: net.isIP(address) })))
        return
      }
      callback(null, filtered[0], net.isIP(filtered[0]))
    })
    .catch(error => callback(error))
}

/** 预热：启动时把要用的域名先解析好，省掉第一轮请求的等待。 */
export async function warmUp(hosts) {
  await Promise.allSettled(hosts.map(host => resolveHost(host)))
}
