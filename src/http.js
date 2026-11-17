/**
 * 出站 HTTP 传输层。
 *
 * 为什么不用 `fetch`：`fetch`（undici）会自己补 `accept-encoding`、`user-agent`，
 * 也允许你「多加」头却不容易「一个都不多加」。上游的风控读的就是这一层**最终字节**，
 * 所以这里用 `node:https` 手工发请求——头完全由 `identity.js` 的构造表决定，
 * Node 只会补传输必需的 `Host` / `Connection`，不会再塞任何指纹。
 *
 * 另外：
 * - **请求体不压缩**。上游网关不解 gzip（实测 400 `Invalid gzip body` /
 *   `Unmarshal chat params failed: invalid character '\x1f'`），见 DEFAULT_GZIP_THRESHOLD。
 *   需要代理时由 `proxyUrl` 显式指定（显式代理本身也会被计数，配置里默认关）。
 * - SSE 按行切，`data:` 载荷逐条交给上层；`[DONE]` 由上层判定。
 *
 * @module src/http.js
 */

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { URL } from 'node:url'

import { toFailure } from './identity.js'
import { pinnedLookup } from './dnsfix.js'

/**
 * 请求体压缩阈值。**默认 0 = 不压缩**。
 *
 * 实测（2026-11-17，直连 `/v2/chat/completions`）：上游网关**不接收 gzip 请求体**。
 * 压缩后的 body 被直接当 JSON 解析，gzip 魔数 `1f 8b` 的首字节 `\x1f` 触发
 * `HTTP 400 · Unmarshal chat params failed: invalid character '\x1f' …`，
 * 另一批节点回 `HTTP 400 · Invalid gzip body`——同一件事的两种说法，说明这是个
 * **混合集群**：部分节点会解压、部分不会，发 gzip 等于碰运气。
 * 明文 64 KB 的请求体每个节点都过。所以这里默认一律明文，别拿可用性赌指纹。
 *
 * 真要按官方客户端行为压（比如哪天确认整集群都解压），把 `gzipThresholdBytes`
 * 设成正数即可恢复；响应侧的 gzip/br 解码不受这里影响（那是正常的响应压缩）。
 */
export const DEFAULT_GZIP_THRESHOLD = 0

/** 瞬时 DNS 失败会在内部自动重试（最多重试这么多次，共 n+1 次尝试）。 */
export const DEFAULT_DNS_RETRIES = 2
const DNS_RETRY_DELAYS = Object.freeze([400, 900])

/**
 * 瞬时 DNS 解析失败：这类错误重发一次往往就好——`getaddrinfo ENOTFOUND` 多数是
 * 路由器/系统 DNS 一时没答上来，不是域名真的不存在（域名是否存在由上游说了算，
 * 这里只做「先试了再说」）。`ENOTFOUND` 之外还覆盖 DNS 服务器忙/瞬时失败的那几个码。
 */
export function isTransientDnsError(error) {
  const code = error?.code
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NODATA' || code === 'ESERVFAIL'
}

/** keep-alive 连接池：同 origin 复用，避免每轮 TLS 握手这种非官方节奏。 */
const agents = new Map()

function agentFor(protocol, keepAlive) {
  const key = `${protocol}:${keepAlive ? 'keep' : 'close'}`
  let agent = agents.get(key)
  if (agent === undefined) {
    const Ctor = protocol === 'http:' ? http.Agent : https.Agent
    agent = new Ctor({ keepAlive, maxSockets: 16 })
    agents.set(key, agent)
  }
  return agent
}

/** 传输层的失败对象，直接就是 DSH 能读的形状。 */
export class TransportError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{status?: number, providerRetryAfterMs?: number, cause?: unknown}} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    if (detail.status !== undefined) this.status = detail.status
    if (detail.providerRetryAfterMs !== undefined) this.providerRetryAfterMs = detail.providerRetryAfterMs
    if (detail.cause !== undefined) this.cause = detail.cause
  }
}

/** 上游响应把重试时间放在 `retry-after` 或 `x-retry-after` 上，单位是秒。 */
export function retryAfterMsOf(headers) {
  const raw = headers['retry-after'] ?? headers['x-retry-after']
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const seconds = Number.parseFloat(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function textBodyOf(body) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body
  return JSON.stringify(body)
}

/**
 * 发一个请求，拿到响应句柄或已读全的响应体。
 *
 * @param {object} input
 * @param {string} input.url
 * @param {'GET'|'POST'} [input.method]
 * @param {Record<string, string>} input.headers - 已经构造好的**完整**头表
 * @param {unknown} [input.body]
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs] - 首字节超时
 * @param {number} [input.gzipThresholdBytes]
 * @param {boolean} [input.keepAlive]
 * @param {boolean} [input.readBody] - true 则整体读入并按 JSON 解析
 */
export function send(input) {
  const { url, method = 'POST', headers, body, signal, timeoutMs = 120_000, gzipThresholdBytes = DEFAULT_GZIP_THRESHOLD, keepAlive = true, readBody = false } = input
  const target = new URL(url)
  const raw = textBodyOf(body)
  const plain = raw === undefined ? undefined : typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  let payload = plain
  const outgoing = { ...headers }
  // 压缩判据：阈值必须是**正数**才启用（`0` = 关闭，绝不能是「>= 0 恒真」）。
  // 默认关闭：上游网关不解 gzip，见 DEFAULT_GZIP_THRESHOLD 的说明。
  const threshold = Number(gzipThresholdBytes)
  let gzipUsed = false
  if (plain !== undefined && Number.isFinite(threshold) && threshold > 0 && plain.length >= threshold) {
    payload = zlib.gzipSync(plain)
    outgoing['content-encoding'] = 'gzip'
    gzipUsed = true
  } else {
    delete outgoing['content-encoding']
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new TransportError('aborted before dispatch', 'ABORTED'))
      return
    }

    /**
     * 派发一次请求。DNS 瞬时失败（getaddrinfo ENOTFOUND 那族）在请求体还没
     * 写出去之前会重试：这类错误多数是路由器/系统 DNS 一时没答上来，重发就好。
     * 域名真不存在时重试两次也不亏——最终仍把 ENOTFOUND 原样交给上层报错。
     */
    const dispatch = attemptsLeft => {
      const request = (target.protocol === 'http:' ? http : https).request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method,
          headers: outgoing,
          agent: agentFor(target.protocol, keepAlive),
          // 绕开系统 getaddrinfo：家用路由器 DNS 偶发 NXDOMAIN 会直接变成
          // `getaddrinfo ENOTFOUND`，域名本身没坏。见 src/dnsfix.js。
          lookup: pinnedLookup,
        },
        response => {
          const status = response.statusCode ?? 0
          /** @type {Record<string, string>} */
          const responseHeaders = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            responseHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value)
          }
          if (!readBody) {
            resolve({ status, headers: responseHeaders, stream: response, gzipUsed })
            return
          }
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            const text = decodeBody(buffer, responseHeaders)
            resolve({ status, headers: responseHeaders, text, json: parseJson(text), gzipUsed })
          })
          response.on('error', error => reject(new TransportError(`response stream failed: ${error.message}`, 'TRANSPORT', { cause: error })))
        },
      )

      const onAbort = () => {
        request.destroy(new TransportError('aborted by the caller', 'ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const clearAbort = () => signal?.removeEventListener('abort', onAbort)

      request.on('error', error => {
        clearAbort()
        if (error?.name === 'TransportError' && error.code === 'ABORTED') {
          reject(error)
          return
        }
        // 瞬时 DNS 失败：这类错误发生在建连之前，请求体根本没发出去过，
        // 还有重试次数就稍等重发——重发的是同一条完整请求，不会出现半包。
        if (attemptsLeft > 0 && isTransientDnsError(error)) {
          setTimeout(() => dispatch(attemptsLeft - 1), DNS_RETRY_DELAYS[DEFAULT_DNS_RETRIES - attemptsLeft] ?? 500)
          return
        }
        const code = error?.code === 'ETIMEDOUT' || error?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT'
        reject(new TransportError(`transport: ${error?.message ?? String(error)}`, code, { cause: error }))
      })
      request.setTimeout(timeoutMs, () => {
        request.destroy(new TransportError(`no response within ${timeoutMs}ms`, 'TIMEOUT'))
      })
      if (payload !== undefined) request.write(payload)
      request.end()
    }

    dispatch(DEFAULT_DNS_RETRIES)
  })
}

/**
 * 上游对「压缩请求体」的两种拒答（混合集群，不同节点说法不同）：
 *   · `HTTP 400 · Invalid gzip body`
 *   · `HTTP 400 · Unmarshal chat params failed … invalid character '\x1f' …`
 * `\x1f` 就是 gzip 魔数 `1f 8b` 的首字节——网关把压缩字节当 JSON 解析了。
 */
export function isGzipBodyRejection(error) {
  const text = `${error?.message ?? ''} ${error?.text ?? ''} ${JSON.stringify(error?.json ?? '')}`
  return /invalid gzip body/i.test(text)
    || /unmarshal chat params failed/i.test(text)
    || /invalid character '\\x1f'/i.test(text)
}

/** 发一个请求并把 JSON 响应读全；非 2xx 直接按上游错误语义抛出。 */
export async function jsonRequest(input) {
  const response = await send({ ...input, readBody: true })
  if (response.status >= 400 || (response.json !== undefined && looksLikeError(response.json))) {
    // 自愈：配置里残留了正的压缩阈值时，gzip 被拒就降级明文重发一次，
    // 而不是把 400 抛给用户。只在「这次确实压过」时重试，不会无限循环。
    if (response.gzipUsed === true && isGzipBodyRejection(response)) {
      return jsonRequest({ ...input, gzipThresholdBytes: 0 })
    }
    throw failureOf(response)
  }
  return response
}

/** 一个响应是否携带了错误外壳。 */
export function looksLikeError(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false
  const record = /** @type {Record<string, unknown>} */ (json)
  if (Number.isFinite(Number(record.code)) && Number(record.code) !== 0 && Number(record.code) !== 200) return true
  if (record.error !== undefined && record.error !== null && record.error !== '' && record.error !== false) return true
  if (record.success === false) return true
  return false
}

/** 由一次响应构造失败对象（HTTP 状态、上游 code、retry-after 三条信息合起来判定）。 */
export function failureOf(response) {
  const payload = response.json ?? response.text ?? ''
  const failure = toFailure(response.status, payload, retryAfterMsOf(response.headers ?? {}))
  const requestId = response.headers?.['x-request-id'] ?? response.headers?.['x-trace-id']
  const error = new TransportError(failure.message, failure.code, {
    status: failure.status,
    providerRetryAfterMs: failure.providerRetryAfterMs,
  })
  if (typeof requestId === 'string' && requestId !== '') error.requestId = requestId
  return error
}

function decodeBody(buffer, headers) {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase()
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8')
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8')
    if (encoding.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8')
  } catch {
    /* 落到明文解码 */
  }
  return buffer.toString('utf8')
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 把一条 SSE 响应切成 `data:` 载荷。
 *
 * 上游在 `stream=true` 时偶发分片损坏（helpers 生态里的记录），所以这里只做
 * 「按行取 data、能解析就交出去、解析不了就跳过」，不做任何重排或聚合——
 * 损坏修复在上层的区块装配里做。
 *
 * @param {import('node:stream').Readable} stream
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<string>}
 */
export async function* sseLines(stream, signal) {
  let buffer = ''
  const decoder = new TextDecoder('utf-8')
  try {
    for await (const chunk of stream) {
      if (signal?.aborted === true) return
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        const payload = dataOf(line)
        if (payload !== undefined) yield payload
        index = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    const payload = dataOf(tail)
    if (payload !== undefined) yield payload
  } finally {
    stream.destroy?.()
  }
}

function dataOf(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith(':')) return undefined
  if (!trimmed.startsWith('data:')) return undefined
  const value = trimmed.slice(5).trim()
  return value === '' ? undefined : value
}

/** 打开一条流式请求：先拿到状态与头，再逐条读 SSE 载荷。 */
export async function openStream(input) {
  const response = await send({ ...input, readBody: false })
  if (response.status >= 400) {
    // 错误响应是 JSON 而不是 SSE：读出来再按语义抛，否则上层会看到「空流」。
    const chunks = []
    for await (const chunk of response.stream) chunks.push(chunk)
    const text = decodeBody(Buffer.concat(chunks), response.headers)
    const payload = { status: response.status, headers: response.headers, text, json: parseJson(text) }
    // 自愈：这次压过、且上游拒的是压缩体 → 明文重发一次（配置残留正阈值时的兜底）。
    if (response.gzipUsed === true && isGzipBodyRejection(payload)) {
      return openStream({ ...input, gzipThresholdBytes: 0 })
    }
    throw failureOf(payload)
  }
  return {
    status: response.status,
    headers: response.headers,
    gzipUsed: response.gzipUsed,
    lines: sseLines(response.stream, input.signal),
  }
}