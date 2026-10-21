/**
 * 插件自己的同源 HTTP 面（设置页读它，不是 Remote 绑定）。
 *
 * 为什么用 `webServer.register` 而不是带类型的 Remote：后者要求宿主侧的生成式 schema
 * 接线，而这条路由在任何内核线上都由同一个宿主进程提供，与 DSH 版本解耦——
 * 这也是该生态里同类插件的通行做法。
 *
 * 安全边界（本机回环上的一个明文接口，按最坏情况设计）：
 *
 * - **只接受回环 Host**：`Host` 头不是 127.0.0.1 / localhost / [::1] 一律 403。
 *   防的是 DNS rebinding 与「网页偷偷 POST 到本机端口」这类跨站调用。
 * - **绝不下发凭据**：所有响应都走 `AccountsStore.view()`，里面没有任何 token 字段。
 * - **请求体上限 64KiB**：这个接口只收 id 与几个开关。
 *
 * @module src/api.js
 */

import { cstParts } from './schedule.js'

export const API_PREFIX = '/api/workbuddy'
const MAX_BODY_BYTES = 64 * 1024

/** 只有回环来源的请求才被受理。 */
export function isLoopbackRequest(req) {
  const host = String(req.headers?.host ?? '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]' || name === ''
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * 登录尝试登记处：一次授权对应一个 `state`，设置页轮询它的状态。
 *
 * 授权在**浏览器**里完成，所以这里只负责「起一次、记着、报状态」，不阻塞任何请求。
 */
export class LoginCoordinator {
  /**
   * @param {object} input
   * @param {(options: {onProgress: Function}) => Promise<{auth: object, account: object}>} input.begin - 由 index.js 提供的真实登录流程
   * @param {{debug?: Function, warn?: Function}} [input.logger]
   */
  constructor({ begin, logger }) {
    this.begin = begin
    this.logger = logger ?? {}
    /** @type {Map<string, {status: string, url?: string, message?: string, account?: object, startedAt: number}>} */
    this.attempts = new Map()
  }

  /** 起一次登录，立刻返回授权链接。 */
  async start() {
    const marker = { status: 'pending', startedAt: Date.now() }
    const key = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.attempts.set(key, marker)
    let resolvedKey
    const onProgress = info => {
      if (typeof info?.url === 'string' && info.url !== '') marker.url = info.url
      if (typeof info?.state === 'string' && info.state !== '' && resolvedKey !== info.state) {
        this.attempts.delete(key)
        resolvedKey = info.state
        this.attempts.set(info.state, marker)
      }
    }
    void (async () => {
      try {
        const result = await this.begin({ onProgress })
        marker.status = 'done'
        marker.account = result?.account ?? undefined
      } catch (error) {
        marker.status = 'failed'
        marker.message = error instanceof Error ? error.message : String(error)
        this.logger.warn?.(`workbuddy: 登录流程结束于失败：${marker.message}`)
      }
      this.sweep()
    })()
    // 给 begin 一个同步窗口把 state/url 打出来（state 请求是一次本地到上游的往返，很快）。
    for (let wait = 0; wait < 40 && marker.url === undefined && marker.status === 'pending'; wait += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return { state: resolvedKey ?? key, url: marker.url }
  }

  status(state) {
    const attempt = this.attempts.get(state)
    if (attempt === undefined) return { status: 'unknown' }
    return {
      status: attempt.status,
      url: attempt.url,
      message: attempt.message,
      account: attempt.account,
    }
  }

  cancel(state) {
    const attempt = this.attempts.get(state)
    if (attempt === undefined) return false
    this.attempts.delete(state)
    return true
  }

  sweep() {
    const cutoff = Date.now() - 15 * 60_000
    for (const [key, attempt] of this.attempts) {
      if (attempt.startedAt < cutoff && attempt.status !== 'pending') this.attempts.delete(key)
    }
  }
}

/**
 * 路由处理器。
 *
 * @param {object} deps
 * @param {import('./accounts.js').AccountsStore} deps.accounts
 * @param {LoginCoordinator} deps.login
 * @param {(options: {account?: object, kind: 'checkin'|'credits'|'refresh'}) => Promise<object>} deps.runTask
 * @param {(options?: {force?: boolean}) => Promise<{rows: object[], error?: string, at: number}>} [deps.catalog]
 * @param {object} [deps.logger]
 * @param {object} [deps.config]
 */
export function createApiHandler(deps) {
  const { accounts, login, runTask, catalog, logger, config } = deps

  return async function handle(req, res) {
    try {
      if (isLoopbackRequest(req) !== true) {
        sendJson(res, 403, { error: 'loopback requests only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (path.startsWith(API_PREFIX) !== true) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const route = path.slice(API_PREFIX.length).replace(/\/+$/, '')
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && (route === '/state' || route === '')) {
        sendJson(res, 200, {
          ...accounts.view(),
          now: cstParts(),
          route: 'codebuddy',
          autoLogin: config?.autoLogin !== false,
        })
        return
      }

      if (method === 'GET' && route === '/login/status') {
        sendJson(res, 200, login.status(url.searchParams.get('state') ?? ''))
        return
      }

      // 模型价格表：哪些免费、倍率多少。设置页用它显示「模型与积分」。
      if (method === 'GET' && route === '/models') {
        if (catalog === undefined) {
          sendJson(res, 200, { rows: [], error: 'catalog unavailable' })
          return
        }
        sendJson(res, 200, await catalog({ force: url.searchParams.get('refresh') === '1' }))
        return
      }

      const body = await readBody(req)

      if (method === 'POST' && route === '/login') {
        const started = await login.start()
        sendJson(res, 200, started)
        return
      }

      if (method === 'POST' && route === '/login/cancel') {
        sendJson(res, 200, { cancelled: login.cancel(String(body.state ?? '')) })
        return
      }

      if (method === 'POST' && route === '/activate') {
        const ok = accounts.activate(String(body.id ?? ''))
        sendJson(res, ok ? 200 : 404, ok ? { ok: true, ...accounts.view() } : { error: 'account not found' })
        return
      }

      if (method === 'POST' && route === '/remove') {
        const ok = accounts.remove(String(body.id ?? ''))
        sendJson(res, ok ? 200 : 404, ok ? { ok: true, ...accounts.view() } : { error: 'account not found' })
        return
      }

      if (method === 'POST' && route === '/settings') {
        accounts.updateSettings(body)
        sendJson(res, 200, { ok: true, ...accounts.view() })
        return
      }

      if (method === 'POST' && route === '/checkin') {
        const result = await runTask({ account: body.id === undefined ? undefined : accounts.byId(String(body.id)), kind: 'checkin' })
        sendJson(res, 200, { ok: true, result, ...accounts.view() })
        return
      }

      if (method === 'POST' && route === '/credits') {
        const result = await runTask({ account: body.id === undefined ? undefined : accounts.byId(String(body.id)), kind: 'credits' })
        sendJson(res, 200, { ok: true, result, ...accounts.view() })
        return
      }

      if (method === 'POST' && route === '/refresh') {
        const result = await runTask({ account: body.id === undefined ? undefined : accounts.byId(String(body.id)), kind: 'refresh' })
        sendJson(res, 200, { ok: true, result, ...accounts.view() })
        return
      }

      sendJson(res, 404, { error: `unknown route ${method} ${route}` })
    } catch (error) {
      logger?.warn?.(`workbuddy: api 处理失败（${error instanceof Error ? error.message : String(error)}）`)
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}