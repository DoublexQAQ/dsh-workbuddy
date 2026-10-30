/**
 * 出站身份层：让 WorkBuddy 上游看到的**只有**官方客户端。
 *
 * 这一层只做三件事，但每件都必须做对：
 *
 * 1. **头的集合与顺序对齐官方抓包**——不是「加上几个像官方客户端的头」，而是
 *    从白名单从头构造：官方客户端没有的头一个不发（海外版尤其如此，多一个
 *    `x-model-id` / `accept-language` 就是特征差异），宿主自己的归属头
 *    （`deepseek-harness/...`、`x-dsh-*`、`x-opencode-*`）连构造的机会都没有。
 * 2. **会话链延续**——同一段对话复用同一个 `conversation_id`、同一条 `b3` 追踪链，
 *    `previous_response_id` 随会话链式传递。上游把「每轮都是新会话 + 新追踪链」
 *    看作机器人特征。
 * 3. **一设备一账号**——国内版的 `x-device-token` 与账号绑定，交给 session 层注入，
 *    这里只负责把它放进正确的位置，并在缺失时如实上报（不发假 token，那是自曝）。
 *
 * @module src/identity.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { HOST_FINGERPRINT_HEADERS, UPSTREAM_CODES } from './platform.js'

/**
 * 命中即拒的宿主归属头。出站前最后一道断言：构造表里出现任何一条都说明
 * 上游会看到「这次调用来自 DSH」。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isHostFingerprintHeader(name) {
  const lower = String(name).toLowerCase()
  return HOST_FINGERPRINT_HEADERS.some(fragment => lower.includes(fragment))
}

/** 该平台禁止发送的头（海外版的「只发官方头集子集」规则）。 */
export function isForbiddenForPlatform(name, profile) {
  const lower = String(name).toLowerCase()
  return (profile.forbidHeaders ?? []).some(forbidden => lower === forbidden)
}

/** 16 位十六进制 span。 */
export function mintSpanId() {
  return crypto.randomBytes(8).toString('hex')
}

/** 32 位十六进制 trace。 */
export function mintTraceId() {
  return crypto.randomBytes(16).toString('hex')
}

/** 官方风格的会话 id。 */
export function mintConversationId(format = 'uuid') {
  if (format === 'b36') return `cb_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`
  if (format === 'compact') return crypto.randomBytes(16).toString('hex')
  return crypto.randomUUID()
}

/** 官方风格的请求 id（b3 之外的单轮标识）。 */
export function mintRequestId() {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * 出站头构造表。
 *
 * 顺序是刻意的：先身份（UA / 产品 / IDE），再认证，再追踪链，最后是内容协商。
 * Node 的 HTTPS 客户端保留对象键的插入顺序，因此调用方拿到的就是上线顺序。
 *
 * @param {object} input
 * @param {object} input.profile - 平台档案
 * @param {{accessToken?: string, userId?: string, domain?: string, enterpriseId?: string}} input.auth
 * @param {string|undefined} input.deviceToken
 * @param {object} input.session - `{ conversationId, traceId, spanId, previousResponseId? }`
 * @param {boolean} input.stream
 * @param {boolean} [input.gzip]
 * @param {Record<string, string>} [input.extra] - 调用方补充的非指纹头（如 content-length 由传输层写）
 * @param {string} [input.userAgent]
 * @returns {Record<string, string>}
 */
export function buildHeaders({ profile, auth, deviceToken, session, stream, gzip = false, extra = {}, userAgent }) {
  /** @type {Record<string, string>} */
  const headers = {}
  const put = (name, value) => {
    if (value === undefined || value === null || value === '') return
    if (isHostFingerprintHeader(name)) throw new Error(`identity: refused to send host fingerprint header "${name}"`)
    if (isForbiddenForPlatform(name, profile)) return
    headers[name] = String(value)
  }

  put('user-agent', userAgent ?? profile.userAgent)
  put('x-product', profile.product)
  put('x-product-version', profile.productVersion)
  put('x-ide-type', profile.ideType)
  put('x-ide-name', profile.ideName)
  put('x-ide-version', profile.ideVersion)

  if (profile.deviceToken) put('x-device-token', deviceToken)

  put('x-user-id', auth.userId)
  put('authorization', auth.accessToken ? `Bearer ${auth.accessToken}` : undefined)
  put('x-domain', auth.domain)
  if (auth.enterpriseId) {
    put('x-enterprise-id', auth.enterpriseId)
    put('x-tenant-id', auth.enterpriseId)
  }

  // b3 追踪链：同会话同 trace，跨轮延续——官方客户端的分布式追踪头就是这个形状。
  if (session?.traceId && session?.spanId) {
    put('b3', `${session.traceId}-${session.spanId}-1`)
    put('x-b3-traceid', session.traceId)
    put('x-b3-spanid', session.spanId)
    put('x-b3-sampled', '1')
  }
  put('x-conversation-id', session?.conversationId)
  put('x-session-id', session?.conversationId)

  for (const [name, value] of Object.entries(extra)) put(name, value)

  put('content-type', 'application/json')
  put('accept', stream ? 'text/event-stream' : 'application/json')
  // 官方客户端对大请求体会压缩；宿主 HTTP 栈的默认 accept-encoding 不是官方头，绝不透传。
  if (gzip) {
    put('content-encoding', 'gzip')
    put('x-content-encoding-overhead', undefined)
  }

  return headers
}

/**
 * 会话 / 追踪链的持久映射。
 *
 * 一段 DSH 会话压到上游的一个 `conversation_id` + 一条 `b3` 链上。落到磁盘是因为
 * 进程重启后「同一个对话换了新会话」本身就是可观测的多会话特征，而上游正是靠
 * 会话维度做额度与风控计账的。
 */
export class IdentityStore {
  /**
   * @param {string} file - JSON 状态文件路径
   * @param {{logger?: {warn?: Function}}} [options]
   */
  constructor(file, options = {}) {
    this.file = file
    this.logger = options.logger
    /** @type {Map<string, {conversationId: string, traceId: string, createdAt: number, lastResponseId?: string}>} */
    this.conversations = new Map()
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [seed, value] of Object.entries(parsed?.conversations ?? {})) {
        if (typeof value?.conversationId === 'string' && typeof value?.traceId === 'string') {
          this.conversations.set(seed, {
            conversationId: value.conversationId,
            traceId: value.traceId,
            createdAt: Number(value.createdAt) || Date.now(),
            ...(typeof value.lastResponseId === 'string' ? { lastResponseId: value.lastResponseId } : {}),
          })
        }
      }
    } catch {
      /* 首次运行或状态文件损坏：从空开始，不阻断模型车道 */
    }
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      const conversations = Object.fromEntries(this.conversations)
      fs.writeFileSync(temp, JSON.stringify({ version: 1, at: Date.now(), conversations }, undefined, 2))
      fs.renameSync(temp, this.file)
    } catch (error) {
      this.logger?.warn?.(`workbuddy: could not persist the conversation chain (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /**
   * 取（必要时铸造）一段对话的链身份，并为本轮分配一个 span。
   *
   * @param {string|undefined} seed - DSH 会话 id；缺省时压到 `global`
   * @param {string} [format]
   */
  chainFor(seed, format = 'uuid') {
    const key = typeof seed === 'string' && seed.trim() !== '' ? seed.trim() : 'global'
    let entry = this.conversations.get(key)
    if (entry === undefined) {
      entry = { conversationId: mintConversationId(format), traceId: mintTraceId(), createdAt: Date.now() }
      this.conversations.set(key, entry)
      this.flush()
    }
    return {
      key,
      conversationId: entry.conversationId,
      traceId: entry.traceId,
      spanId: mintSpanId(),
    }
  }

  /** 记录上游给出的响应 id，供下一轮 `previous_response_id` 延续。 */
  noteResponseId(key, responseId) {
    if (typeof responseId !== 'string' || responseId === '') return
    const entry = this.conversations.get(key)
    if (entry === undefined) return
    if (entry.lastResponseId === responseId) return
    entry.lastResponseId = responseId
    this.flush()
  }

  previousResponseId(key) {
    return this.conversations.get(key)?.lastResponseId
  }
}

/**
 * 从上游响应体里读出「官方错误码」。
 *
 * 上游把可诊断的原因放在 `code`（有时是字符串数字，有时嵌在 `error` 里），
 * 这一层把两类位置都归一到数字上。
 *
 * @param {unknown} payload
 * @returns {number|undefined}
 */
export function upstreamCodeOf(payload) {
  const candidates = []
  const visit = (node, depth) => {
    if (node === null || depth > 3) return
    if (typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (node)
    candidates.push(record.code, record.errCode, record.errorCode)
    // 上游把诊断码裹在 data / error / response 里，三种信封都要往里走。
    visit(record.error, depth + 1)
    visit(record.data, depth + 1)
    visit(record.response, depth + 1)
  }
  visit(payload, 0)
  for (const candidate of candidates) {
    const numeric = typeof candidate === 'number' ? candidate : Number.parseInt(String(candidate), 10)
    if (Number.isFinite(numeric) && UPSTREAM_CODES[String(numeric)] !== undefined) return numeric
  }
  return undefined
}

/**
 * 把上游的 HTTP 状态 + 错误码压成 DSH 的失败对象。
 *
 * 401/403 归到凭据（需要重新登录），429 与 6004/14003 归到频控且**不重试**
 * （上游的 retry-after 是「越来越大」的形状，自动重试只会把一次配额墙变成三次）。
 *
 * @param {number|undefined} status
 * @param {unknown} payload
 * @param {number|undefined} retryAfterMs
 * @returns {{message: string, code: string, status?: number, providerRetryAfterMs?: number}}
 */
export function toFailure(status, payload, retryAfterMs) {
  const code = upstreamCodeOf(payload)
  const known = code === undefined ? undefined : UPSTREAM_CODES[String(code)]
  const text = extractMessage(payload)
  const base = known === undefined ? undefined : known.code
  let settled = base ?? 'SERVER'
  if (base === undefined) {
    if (status === 401 || status === 403) settled = 'CREDENTIAL'
    else if (status === 429) settled = 'RATE_LIMIT'
    else if (status !== undefined && status >= 400 && status < 500) settled = 'CLIENT'
    else settled = 'SERVER'
  }
  const detail = [
    status === undefined ? undefined : `HTTP ${status}`,
    code === undefined ? undefined : `code ${code}`,
    known === undefined ? undefined : known.reason,
    text,
  ].filter(part => typeof part === 'string' && part !== '')
  const failure = { message: detail.join(' · ') || 'upstream failure', code: settled }
  if (status !== undefined) failure.status = status
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) failure.providerRetryAfterMs = retryAfterMs
  return failure
}

/**
 * 这个失败是不是「账号积分/额度不足」。
 *
 * 上游的 402 与余额类文案（insufficient balance / 余额不足 / quota exceeded）都算。
 * 识别到就把该账号的已知余额按 0 记账，让积分闸门立刻把它切下去——
 * 比等下一次 400/401 再猜要准，也不浪费请求。
 *
 * @param {{message?: string, code?: string, status?: number}} failure
 */
export function isBalanceExhausted(failure) {
  if (failure?.status === 402) return true
  const text = String(failure?.message ?? '')
  return /insufficient\s+(balance|credit)|quota\s+(exceeded|exhausted)|balance\s+(not\s+)?(enough|insufficient|exhausted)|余额不足|积分不足|额度不足|欠费/i.test(text)
}

/** 从上游各种错误外壳里捞出人能读的那句话。 */
export function extractMessage(payload) {
  if (typeof payload === 'string') return payload.slice(0, 400)
  if (payload === null || typeof payload !== 'object') return ''
  const record = /** @type {Record<string, unknown>} */ (payload)
  for (const key of ['message', 'msg', 'errorMsg', 'error_description']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value.slice(0, 400)
  }
  const error = record.error
  if (typeof error === 'string') return error.slice(0, 400)
  if (error !== null && typeof error === 'object') return extractMessage(error)
  const data = record.data
  if (data !== null && typeof data === 'object') return extractMessage(data)
  return ''
}

/**
 * 上游把真正的载荷包在 `{data: {data: ...}}` 里（插件协议的老习惯），
 * 这一层负责把两种嵌套都剥开。
 */
export function unwrapEnvelope(payload) {
  let current = payload
  for (let depth = 0; depth < 3; depth += 1) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current
    const record = /** @type {Record<string, unknown>} */ (current)
    if (record.data !== undefined && Object.keys(record).length <= 3) current = record.data
    else return current
  }
  return current
}