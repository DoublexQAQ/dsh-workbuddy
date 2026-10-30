/**
 * 凭据层：登录、刷新、注入。
 *
 * 这是全局唯一允许「和上游建立信任」的地方，协议取自 CodeBuddy / WorkBuddy
 * 官方插件协议的逆向记录（`cli-external-link`，`/v2/plugin/` 前缀，两个平台同一套）：
 *
 * ```
 * POST /v2/plugin/auth/state?platform=<p>   (X-No-Authorization: true, body {})
 *   -> { authUrl, state }                    ← 浏览器 SSO 登录链接
 * GET  /v2/plugin/auth/token?state=<state>   (轮询)
 *   -> { accessToken, refreshToken, expiresAt, domain }
 * GET  /v2/plugin/login/account?state=<state>
 *   -> { uid, nickname, enterpriseId }
 * POST /v2/plugin/auth/token/refresh         (X-Refresh-Token, X-Auth-Refresh-Source: plugin)
 *   -> 新 token
 * ```
 *
 * 凭据来源按优先级：显式配置 > 环境变量 > 插件自己的状态文件 > 该生态通用的
 * `~/.codebuddy-session.json` / `~/.workbuddy-ai-session.json`。这样既能独立工作，
 * 也能直接复用用户已经用别家网关登录好的会话（少一次登录，也少一份 token 落盘）。
 *
 * ⚠️ 登录请求本身也发官方 UA / 产品头：登录是**最**容易被判非官方客户端的一环。
 *
 * @module src/session.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { jsonRequest } from './http.js'
import { extractMessage } from './identity.js'

/** 插件自己的状态目录（不放在 dsh profile 里：登录态与宿主安装目录解耦）。 */
export const STATE_DIR_NAME = '.dsh-workbuddy'

/** 默认状态目录。 */
export function defaultStateDir() {
  return path.join(os.homedir(), STATE_DIR_NAME)
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function writeJsonPrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, undefined, 2))
  try {
    fs.chmodSync(temp, 0o600)
  } catch {
    /* Windows 上没有 0600 语义，忽略 */
  }
  fs.renameSync(temp, file)
}

/**
 * 打开浏览器的后台动作；失败不影响登录（URL 已经写进日志，设置页也给出链接）。
 *
 * ⚠️ Windows 上**不能走 `cmd start`**：授权链接形如
 * `…/login?platform=VSCode&state=<uuid>`，cmd 把 `&` 当命令分隔符——实测（2026-10-30）
 * 无论给 URL 加不加引号、`start ""` 用不用标题占位，`&state=…` 都会从参数里消失
 * （node → cmd 的命令行转义救不回来）。浏览器拿到无 state 的链接，用户登的是另一个
 * state，插件轮询的那个 state 永远回 `11217 login ing…`，最后 `login timed out`——
 * 这就是「点了登录但登不上」的真因。
 *
 * 走 `powershell -EncodedCommand Start-Process`：脚本以 UTF-16LE base64 进内存，
 * URL 是 PS 单引号字符串字面量，不经过 cmd 解析——实测含 `&` 的 URL 逐字符保真。
 */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const script = `Start-Process -LiteralPath '${String(url).replace(/'/g, "''")}'`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return true
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/** 唯一标识一次登录尝试。 */
function mintState() {
  return crypto.randomBytes(16).toString('hex')
}

export class SessionStore {
  /**
   * @param {object} input
   * @param {object} input.profile - 平台档案
   * @param {object} input.config - 插件 config
   * @param {{debug?: Function, warn?: Function, info?: Function}} [input.logger]
   */
  constructor({ profile, config, logger }) {
    this.profile = profile
    this.config = config
    this.logger = logger ?? {}
    this.stateDir = config.stateDir ? path.resolve(config.stateDir) : defaultStateDir()
    this.stateFile = config.sessionFile ? path.resolve(config.sessionFile) : path.join(this.stateDir, `${profile.route}-session.json`)
    this.deviceTokenFile = profile.deviceToken
      ? config.deviceTokenFile
        ? path.resolve(config.deviceTokenFile)
        : path.join(os.homedir(), profile.defaultDeviceTokenFile)
      : ''
    /** 正在进行的登录，避免并发调用各开一次浏览器。 */
    this.pendingLogin = undefined
    /** @type {{auth?: Record<string, unknown>, account?: Record<string, unknown>, source?: string}} */
    this.state = config.token ? { auth: {}, account: {}, source: 'config' } : this.loadState()
    /**
     * 多账号池（可选）。挂上池子之后，凭据、设备头、刷新与故障转移都由池子决定；
     * 没挂时这个类就是单账号身份，行为与挂池子之前完全一致。
     *
     * @type {import('./accounts.js').AccountsStore | undefined}
     */
    this.accounts = undefined
    /** 登录成功回调（index.js 用它把新账号并进池子）。 */
    this.onLoginSuccess = undefined
  }

  /** 挂上账号池。 */
  attachAccounts(accounts) {
    this.accounts = accounts
    return this
  }

  loadState() {
    const explicit = readJson(this.stateFile)
    if (explicit?.auth?.accessToken) return { ...explicit, source: this.stateFile }
    const legacy = this.profile.route === 'codebuddy'
      ? [path.join(os.homedir(), '.codebuddy-session.json'), path.join(os.homedir(), '.workbuddy-ai-session.json')]
      : [path.join(os.homedir(), '.workbuddy-ai-session.json')]
    for (const file of legacy) {
      const shared = readJson(file)
      if (shared?.auth?.accessToken) {
        this.logger.debug?.(`workbuddy: reusing the session at ${file}`)
        return { ...shared, source: file }
      }
    }
    return { auth: {}, account: {}, source: 'none' }
  }

  saveState(next) {
    this.state = next
    // 有账号池时，凭据的唯一归属是池子里的那一行；同时通知宿主把新账号并进池子。
    if (this.onLoginSuccess !== undefined) {
      try {
        this.onLoginSuccess({ auth: next.auth ?? {}, account: next.account ?? {}, route: this.profile.route })
      } catch (error) {
        this.logger.warn?.(`workbuddy: 账号并入池子失败（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    try {
      writeJsonPrivate(this.stateFile, { version: 1, at: Date.now(), route: this.profile.route, auth: next.auth, account: next.account })
    } catch (error) {
      this.logger.warn?.(`workbuddy: could not persist the session (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /** 静态注入的凭据（config / 环境变量）优先于任何文件。 */
  staticCredentials() {
    const env = process.env
    const routeEnv = this.profile.route === 'codebuddy' ? 'CODEBUDDY' : 'WORKBUDDY'
    const accessToken = this.config.token
      ?? env[`${routeEnv}_ACCESS_TOKEN`]
      ?? env.CODEBUDDY_TOKEN
      ?? env.WORKBUDDY_TOKEN
    const refreshToken = this.config.refreshToken
      ?? env[`${routeEnv}_REFRESH_TOKEN`]
      ?? env.CODEBUDDY_REFRESH_TOKEN
      ?? env.WORKBUDDY_REFRESH_TOKEN
    const userId = this.config.userId ?? env.CODEBUDDY_USER_ID ?? env.WORKBUDDY_USER_ID
    const domain = this.config.domain
    const enterpriseId = this.config.enterpriseId ?? env.CODEBUDDY_ENTERPRISE_ID
    if (!accessToken && !refreshToken) return undefined
    return {
      auth: {
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(this.config.expiresAt ? { expiresAt: this.config.expiresAt } : {}),
        ...(domain ? { domain } : {}),
      },
      account: {
        ...(userId ? { uid: userId } : {}),
        ...(enterpriseId ? { enterpriseId } : {}),
      },
      source: 'config',
      static: true,
    }
  }

  /** 当前可用的认证材料，供 `identity.buildHeaders()` 使用。 */
  credentials() {
    const injected = this.staticCredentials()
    if (injected?.auth?.accessToken) {
      return { accessToken: String(injected.auth.accessToken), userId: stringOf(injected.account?.uid), domain: stringOf(injected.auth.domain), enterpriseId: stringOf(injected.account?.enterpriseId) }
    }
    // 池子优先，而且**只认本路由的账号**：国内账号的凭据在海外域毫无意义。
    const pooled = this.accounts?.active?.(this.profile.route)
    if (pooled?.auth?.accessToken !== undefined) {
      return {
        accessToken: stringOf(pooled.auth.accessToken),
        refreshToken: stringOf(pooled.auth.refreshToken),
        userId: stringOf(pooled.uid),
        uid: stringOf(pooled.uid),
        domain: stringOf(pooled.auth.domain ?? pooled.domain),
        enterpriseId: stringOf(pooled.enterpriseId),
      }
    }
    const auth = this.state.auth ?? {}
    const account = this.state.account ?? {}
    return {
      accessToken: stringOf(auth.accessToken),
      userId: stringOf(account.uid),
      domain: stringOf(auth.domain),
      enterpriseId: stringOf(account.enterpriseId),
    }
  }

  /** 一设备一账号的 device token（仅国内版有）。缺失就如实为空。 */
  deviceToken() {
    if (!this.profile.deviceToken) return undefined
    const raw = this.config.deviceToken ?? process.env.CODEBUDDY_DEVICE_TOKEN
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    if (this.deviceTokenFile !== '') {
      const text = (() => {
        try {
          return fs.readFileSync(this.deviceTokenFile, 'utf8')
        } catch {
          return ''
        }
      })()
      const trimmed = text.trim()
      if (trimmed === '') return undefined
      if (trimmed.startsWith('{')) {
        const parsed = readJson(this.deviceTokenFile)
        const value = parsed?.deviceToken ?? parsed?.token ?? parsed?.value
        return typeof value === 'string' && value !== '' ? value : undefined
      }
      return trimmed
    }
    return undefined
  }

  /** 登录态是否可用（含 60 秒时钟偏移余量）。 */
  isFresh() {
    const pooled = this.accounts?.active?.(this.profile.route)
    const auth = pooled?.auth ?? this.state.auth ?? {}
    if (typeof auth.accessToken !== 'string' || auth.accessToken === '') return false
    const remaining = remainingMs(auth)
    if (remaining === undefined) return true
    return remaining > 60_000
  }

  /** 官方 UA / 产品头 + 指定认证头，用于登录与刷新这类控制面请求。 */
  controlHeaders(extra = {}) {
    const headers = {
      'user-agent': this.config.userAgent ?? this.profile.userAgent,
      'x-product': this.profile.product,
      'x-product-version': this.profile.productVersion,
      'x-ide-type': this.profile.ideType,
      'x-ide-name': this.profile.ideName,
      'x-ide-version': this.profile.ideVersion,
      accept: 'application/json',
      'content-type': 'application/json',
    }
    return { ...headers, ...extra }
  }

  /**
   * 用 refresh token 换新 access token。
   * @returns {Promise<boolean>}
   */
  async refresh() {
    const injected = this.staticCredentials()
    const pooled = this.accounts?.active?.(this.profile.route)
    // 凭据还新鲜就别刷新：上游对「刚签发、还没过期」的 refresh token 会回 invalid_grant，
    // 而无条件刷新会让日志里堆满看着像故障的噪声。
    const remaining = remainingMs(pooled?.auth ?? this.state.auth ?? {})
    if (remaining !== undefined && remaining > 120_000) return true
    const refreshToken = injected?.static === true
      ? undefined
      : (pooled?.auth?.refreshToken ?? this.state.auth?.refreshToken ?? injected?.auth?.refreshToken)
    if (typeof refreshToken !== 'string' || refreshToken === '') return false
    const credentials = this.credentials()
    try {
      const response = await jsonRequest({
        url: `${this.profile.endpoint}/v2/plugin/auth/token/refresh`,
        method: 'POST',
        headers: this.controlHeaders({
          'x-refresh-token': refreshToken,
          'x-auth-refresh-source': 'plugin',
          ...(credentials.userId ? { 'x-user-id': credentials.userId } : {}),
          ...(credentials.domain ? { 'x-domain': credentials.domain } : {}),
        }),
        body: {},
        timeoutMs: Number(this.config.requestTimeoutMs ?? 30_000),
        signal: undefined,
      })
      const token = unwrapAuth(response.json) ?? {}
      if (typeof token.accessToken !== 'string' || token.accessToken === '') return false
      // 池子里那一行是凭据的唯一归属：刷新结果写回它，而不是写一个旁路文件。
      if (pooled !== undefined && this.accounts !== undefined) {
        this.accounts.update(pooled.id, {
          auth: { ...pooled.auth, ...token, refreshToken: token.refreshToken ?? pooled.auth?.refreshToken },
          ...(typeof token.domain === 'string' && token.domain !== '' ? { domain: token.domain } : {}),
        })
      } else {
        this.saveState({ ...this.state, auth: { ...this.state.auth, ...token }, source: 'refresh' })
      }
      this.logger.debug?.('workbuddy: access token refreshed')
      return true
    } catch (error) {
      const message = extractMessage(error) || (error instanceof Error ? error.message : String(error))
      // `invalid_grant` 有两种成因：token 真的失效了，或者「刚签发就拿来换」被拒。
      // 后者不是故障，降级成 debug，别把日志染红。
      if (/invalid_grant|Invalid refresh token/i.test(message)) {
        this.logger.debug?.(`workbuddy: refresh token 未被接受（${message}）；继续用现有 access token`)
      } else {
        this.logger.warn?.(`workbuddy: token refresh failed (${message})`)
      }
      return false
    }
  }

  /**
   * 刷新**指定账号**的 token（与「当前账号」无关，积分任务要能逐个账号跑）。
   *
   * @param {object} account - 池子里的一行
   * @returns {Promise<boolean>}
   */
  async refreshAccount(account) {
    const refreshToken = account?.auth?.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken === '') return false
    const remaining = remainingMs(account?.auth ?? {})
    if (remaining !== undefined && remaining > 120_000) return true
    try {
      const response = await jsonRequest({
        url: `${this.profile.endpoint}/v2/plugin/auth/token/refresh`,
        method: 'POST',
        headers: this.controlHeaders({
          'x-refresh-token': refreshToken,
          'x-auth-refresh-source': 'plugin',
          ...(account.uid ? { 'x-user-id': String(account.uid) } : {}),
          ...(account.auth?.domain ?? account.domain ? { 'x-domain': String(account.auth?.domain ?? account.domain) } : {}),
        }),
        body: {},
        timeoutMs: Number(this.config.requestTimeoutMs ?? 30_000),
        signal: undefined,
      })
      const token = unwrapAuth(response.json) ?? {}
      if (typeof token.accessToken !== 'string' || token.accessToken === '') return false
      this.accounts?.update(account.id, {
        auth: { ...account.auth, ...token, refreshToken: token.refreshToken ?? account.auth?.refreshToken },
      })
      return true
    } catch (error) {
      this.logger.debug?.(`workbuddy: 账号 ${account?.nickname ?? account?.uid ?? account?.id} 刷新失败（${extractMessage(error) || (error instanceof Error ? error.message : String(error))}）`)
      return false
    }
  }

  /**
   * 指定账号的（必要时刷新过的）调用凭据。
   *
   * @param {object} account
   */
  async credentialsFor(account) {
    const remaining = remainingMs(account?.auth ?? {})
    // 只有「确实拿不到 token」或「已确认过期（带 60s 余量）」才刷新；
    // 无从判断时直接用现有 token——真过期了上游会回 401，那条路更便宜也更准。
    const stale = typeof account?.auth?.accessToken !== 'string'
      || account.auth.accessToken === ''
      || (remaining !== undefined && remaining <= 60_000)
    if (stale) await this.refreshAccount(account)
    const fresh = this.accounts?.byId(account.id) ?? account
    return {
      accessToken: stringOf(fresh?.auth?.accessToken),
      refreshToken: stringOf(fresh?.auth?.refreshToken),
      userId: stringOf(fresh?.uid),
      uid: stringOf(fresh?.uid),
      domain: stringOf(fresh?.auth?.domain ?? fresh?.domain),
      enterpriseId: stringOf(fresh?.enterpriseId),
    }
  }

  /**
   * 浏览器 SSO 登录。返回登录后的账号信息；超时抛出携带 authUrl 的错误。
   *
   * @param {{signal?: AbortSignal}} [options]
   */
  async login(options = {}) {
    if (this.pendingLogin !== undefined) return this.pendingLogin
    const run = this.runLogin(options)
    this.pendingLogin = run
    try {
      return await run
    } finally {
      this.pendingLogin = undefined
    }
  }

  async runLogin(options) {
    const timeoutMs = Number(this.config.loginTimeoutMs ?? 180_000)
    const platform = this.profile.platform
    const state = mintState()
    const started = await jsonRequest({
      url: `${this.profile.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}&state=${encodeURIComponent(state)}`,
      method: 'POST',
      headers: this.controlHeaders({
        'x-no-authorization': 'true',
        'x-no-user-id': 'true',
        'x-no-enterprise-id': 'true',
        'x-no-department-info': 'true',
      }),
      body: {},
      timeoutMs: Number(this.config.requestTimeoutMs ?? 30_000),
      signal: options.signal,
    })
    const payload = unwrapAuth(started.json) ?? {}
    const authUrl = typeof payload.authUrl === 'string' ? payload.authUrl : undefined
    const serverState = typeof payload.state === 'string' && payload.state !== '' ? payload.state : state
    if (authUrl === undefined) throw new Error(`login: upstream returned no authUrl (${JSON.stringify(payload).slice(0, 200)})`)
    // 授权链接先交给调用方（设置页要拿它显示/打开），再决定要不要自己开浏览器。
    options.onProgress?.({ url: authUrl, state: serverState })
    this.logger.warn?.(`workbuddy: 需要在浏览器完成一次授权登录（${platform}）：${authUrl}`)
    if (this.config.openBrowser !== false) openBrowser(authUrl)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (options.signal?.aborted === true) throw new Error('login aborted')
      await delay(Number(this.config.loginPollIntervalMs ?? 1500), options.signal)
      let token
      try {
        const polled = await jsonRequest({
          url: `${this.profile.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(serverState)}`,
          method: 'GET',
          headers: this.controlHeaders({
            'x-no-authorization': 'true',
            'x-no-user-id': 'true',
            'x-no-enterprise-id': 'true',
            'x-no-department-info': 'true',
          }),
          timeoutMs: Number(this.config.requestTimeoutMs ?? 30_000),
          signal: options.signal,
        })
        token = unwrapAuth(polled.json)
      } catch {
        continue
      }
      if (token === undefined || typeof token.accessToken !== 'string' || token.accessToken === '') continue
      let account
      try {
        const fetched = await jsonRequest({
          url: `${this.profile.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(serverState)}`,
          method: 'GET',
          headers: this.controlHeaders({
            'x-no-user-id': 'true',
            'x-no-enterprise-id': 'true',
            'x-no-department-info': 'true',
            authorization: `Bearer ${token.accessToken}`,
            ...(typeof token.domain === 'string' && token.domain !== '' ? { 'x-domain': token.domain } : {}),
          }),
          timeoutMs: Number(this.config.requestTimeoutMs ?? 30_000),
          signal: options.signal,
        })
        account = unwrapAuth(fetched.json) ?? {}
      } catch {
        account = {}
      }
      this.saveState({ auth: token, account, source: 'login' })
      this.logger.warn?.(`workbuddy: 授权完成，账号 ${account?.nickname ?? account?.uid ?? '<unknown>'}`)
      return { auth: token, account }
    }
    const error = new Error(`login timed out after ${timeoutMs}ms; 打开这个链接完成授权后重试：${authUrl}`)
    error.authUrl = authUrl
    throw error
  }

  /**
   * 保证有一次可用的调用凭据。
   *
   * @param {{signal?: AbortSignal}} [options]
   */
  async ensureAuth(options = {}) {
    if (this.credentials().accessToken !== undefined && this.isFresh()) return this.credentials()
    const injected = this.staticCredentials()
    if (injected?.auth?.accessToken !== undefined && this.config.trustStaticToken !== false) return this.credentials()
    if (await this.refresh()) return this.credentials()
    // 池子故障转移：当前账号刷不动时换下一个启用账号再试一次（设置页里能看到顶上的是谁）。
    if (this.accounts !== undefined && this.config.failover !== false) {
      const active = this.accounts.active(this.profile.route)
      const next = this.accounts.rotate(active)
      if (next !== undefined) {
        this.logger.warn?.(`workbuddy: 当前账号不可用，已切到 ${next.nickname ?? next.uid ?? next.id}`)
        if (this.credentials().accessToken !== undefined && this.isFresh()) return this.credentials()
        if (await this.refresh()) return this.credentials()
      }
    }
    if (this.config.autoLogin === false) {
      throw new Error(`workbuddy: 没有可用的 ${this.profile.label} 凭据。到「设置 → WorkBuddy 账号」里登录一个，或把 autoLogin 打开后重试。`)
    }
    await this.login(options)
    return this.credentials()
  }
}

/** 从任意信封形状里取出登录载荷。 */
export function unwrapAuth(payload) {
  let current = payload
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    const record = /** @type {Record<string, unknown>} */ (current)
    if (hasAuthShape(record)) return record
    if (record.data === undefined) return undefined
    current = record.data
  }
  return undefined
}

function hasAuthShape(record) {
  return typeof record.accessToken === 'string'
    || typeof record.authUrl === 'string'
    || record.uid !== undefined
    || record.nickname !== undefined
}

function stringOf(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/**
 * 从 access token 里读真实过期时刻（毫秒）。
 *
 * 为什么要解 JWT：登录响应**不一定带 `expiresAt`**（实测国内账号的 token 对象里没有这个字段），
 * 而「过期时间未知」会被保守逻辑判成「可能过期」，于是每次调用都先发一次刷新——
 * 上游对一个刚签发、还没过期的 refresh token 回 `invalid_grant`，日志里就成了
 * 「token refresh failed」，账号看着像坏了。这里解出 `exp`（只读，不校验签名）作为权威依据。
 *
 * @param {string|undefined} token
 * @returns {number|undefined} 毫秒时间戳
 */
export function tokenExpiry(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 一份凭据还剩多少毫秒。`undefined` = 无从判断（按「未知」处理，不做无条件刷新）。
 *
 * @param {{accessToken?: string, expiresAt?: number}} auth
 */
export function remainingMs(auth) {
  const candidates = []
  const fromField = Number(auth?.expiresAt)
  if (Number.isFinite(fromField) && fromField > 0) candidates.push(fromField < 1e12 ? fromField * 1000 : fromField)
  const fromJwt = tokenExpiry(auth?.accessToken)
  if (fromJwt !== undefined) candidates.push(fromJwt)
  if (candidates.length === 0) return undefined
  return Math.min(...candidates) - Date.now()
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(handle)
      reject(new Error('aborted'))
    }, { once: true })
  })
}