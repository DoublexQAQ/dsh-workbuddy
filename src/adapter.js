/**
 * DSH 的 provider 适配器。
 *
 * 它按**结构化契约**满足 `ctx.llm.registerAdapter()`——内核是按「方法能不能调用」
 * 校验的，不做 `instanceof`，所以这里不需要导入任何 `@deepseek-ai/*` 基类，
 * 也就不会把插件钉死在某个内核版本上。
 *
 * 一次调用的顺序固定为：
 *
 * ```
 * 凭据(登录/刷新) -> 历史配对修复 -> 消息投影 -> 正文指纹清洗 -> 组装官方请求
 *   -> 出站 -> SSE -> DSH StreamChunk
 * ```
 *
 * 任何一步失败都变成终局 chunk（`error` / `aborted`），而不是抛给内核，
 * 这样 DSH 能把失败原因原样呈现给用户，重试策略也仍然按 provider 声明生效。
 *
 * @module src/adapter.js
 */

import { buildHeaders, isBalanceExhausted } from './identity.js'
import { displayDescription, displayName } from './catalog.js'
import { DegradeWindow, isSecurityRejection, neutralizeChatBody } from './prompt.js'
import { openStream, TransportError } from './http.js'
import { needsVision, repairToolPairing, toChatMessages, toToolDefs } from './messages.js'
import { sanitizeOutbound } from './sanitize.js'
import { readChatStream } from './stream.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, EFFORT_MAP, PLATFORMS } from './platform.js'

/** 模型 id 尾部可能带着 `(high)` 之类的档位后缀，查表前先剥掉。 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/** 声明给 DSH 的思考强度菜单。 */
const EFFORTS = Object.freeze([
  { id: 'low', name: '低', description: '更快，思考更少' },
  { id: 'medium', name: '中', description: '默认档' },
  { id: 'high', name: '高', description: '上游 thinking 打开，最慢' },
])

export class WorkBuddyAdapter {
  /**
   * @param {object} deps
   * @param {(route: string) => object} deps.profileFor
   * @param {(route: string) => import('./session.js').SessionStore} deps.sessionFor
   * @param {(route: string) => import('./identity.js').IdentityStore} deps.identityFor
   * @param {object} deps.config
   * @param {{debug?: Function, warn?: Function, info?: Function}} [deps.logger]
   * @param {(event: object) => void} [deps.record] - 诊断记录（脱敏后的出站摘要）
   */
  constructor(deps) {
    this.deps = deps
    this.logger = deps.logger ?? {}
    /** 内容安全降级窗口：某条路由被 system 指纹拦过后，当天剩余时间直接走中性提示词。 */
    this.degrade = new DegradeWindow()
  }

  /** @param {string} provider */
  providerInfo(provider) {
    const profile = this.deps.profileFor(provider)
    return { id: provider, name: profile?.label ?? provider }
  }

  /**
   * 重试策略：**顶层**放退避字段（内核直接读这几个字段，嵌在 `backoff` 里会让
   * 每次延迟变成 NaN，进而被持久日志拒收）。
   *
   * 频控与凭据类失败刻意不在可重试集合里：上游的 retry-after 是「越来越大」的形状，
   * 自动重试只会把一次配额墙变成三次。
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 800,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /** 上游没有统一的图像计价协议：不声明，交给宿主自己的估算。 */
  imageRequestPricing() {
    return undefined
  }

  /** 视觉请求的目标尺寸（上游把图片下载成 data URI 再内联）。 */
  imageRequestTarget(provider, model, image) {
    const maxBytes = Number(this.deps.config.imageMaxBytes ?? 4 * 1024 * 1024)
    const width = Number(image?.width) > 0 ? Number(image.width) : 1568
    const height = Number(image?.height) > 0 ? Number(image.height) : 1568
    void provider
    void model
    return { width, height, maxBytes }
  }

  /**
   * 模型选择器里的清单。
   *
   * 名字里**必须**带计价（`免费` / `×0.29`）：DSH 的模型选择器按 provider 分组、
   * 稳定显示的只有 name，所以「是不是免费、倍率多少」只有写进 name 才看得见。
   * 数据来自该账号可见的上游模型目录（倍率是**按账号权限**下发的），取不到就回落静态表。
   *
   * @param {string} provider
   */
  async listModels(provider) {
    const profile = this.deps.profileFor(provider)
    const staticRows = (profile?.models ?? []).map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      description: entry.efforts ? '思考强度可调 · 倍率未知' : undefined,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
    const rows = await this.catalogRows(provider)
    if (rows.length === 0) return staticRows
    const hidden = new Set(Array.isArray(this.deps.config.hideModels) ? this.deps.config.hideModels : [])
    return rows
      .filter(row => row.id !== '' && hidden.has(row.id) !== true)
      .map(row => ({
        provider,
        id: row.id,
        name: displayName(row),
        description: displayDescription(row),
        inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
      }))
  }

  /**
   * 取本路由当前账号可见的上游模型目录（带缓存；没有账号或取不到就回落静态表）。
   *
   * @param {string} provider
   * @returns {Promise<object[]>}
   */
  async catalogRows(provider) {
    const catalog = this.deps.catalog
    const accounts = this.deps.accounts
    if (catalog === undefined || accounts === undefined) return []
    const account = accounts.active(provider)
    if (account === undefined) return []
    const cached = catalog.peek({ route: provider, account })
    if (cached !== undefined && Array.isArray(cached.rows) && cached.rows.length > 0) return cached.rows
    try {
      const session = this.deps.sessionFor(provider)
      const auth = await session.credentialsFor(account)
      const fetched = await catalog.get({ route: provider, account, auth, config: this.deps.config })
      return Array.isArray(fetched.rows) ? fetched.rows : []
    } catch {
      return []
    }
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const profile = this.deps.profileFor(provider)
    const id = baseModelId(model)
    const entry = (profile?.models ?? []).find(candidate => candidate.id === id)
    const catalogRow = (await this.catalogRows(provider)).find(row => row.id === id)
    const contextWindow = Number(catalogRow?.contextWindow) || Number(entry?.contextWindow) || Number(this.deps.config.contextWindow) || DEFAULT_CONTEXT_WINDOW
    const defaultMaxTokens = Number(catalogRow?.maxOutput) || Number(entry?.maxOutput) || Number(this.deps.config.maxTokens) || DEFAULT_MAX_OUTPUT
    const thinking = catalogRow?.thinking === true || (catalogRow === undefined && entry?.efforts === true)
    const reasoning = thinking
      ? { efforts: EFFORTS, defaultEffort: normaliseEffort(catalogRow?.defaultEffort) }
      : undefined
    return {
      provider,
      id: entry?.id ?? id,
      name: catalogRow?.name ?? entry?.name ?? id,
      inputModalities: (catalogRow?.vision === true || entry?.vision === true) ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * 绑定一次调用：模型元信息 + 派发闭包。
   *
   * @param {string} provider
   * @param {string} model
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: options => this.stream({ ...options, provider, model: resolved.id }),
    }
  }

  /**
   * 一次模型调用的入口（DSH 直接调用这条）。
   *
   * 原生 async generator 的 `return` 会排在 pending 的 `next` 之后，所以先取消出站请求，
   * 才能立刻退出——否则用户点「停止」后要等上游把整轮吐完。
   *
   * @param {object} options - GenerateOptions
   */
  stream(options) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal })
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done === true) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: value => step('next', value),
      return: value => {
        controller.abort()
        cleanup()
        return step('return', value)
      },
      throw: error => {
        controller.abort(error)
        cleanup()
        return step('throw', error)
      },
    }
  }

  /**
   * 一轮真实调用。
   *
   * @param {object} options - GenerateOptions（signal 已换成内部 controller 的）
   */
  async * runStream(options) {
    const provider = String(options.provider ?? 'workbuddy')
    const profile = this.deps.profileFor(provider)
    if (profile === undefined) {
      yield errorChunk(`unknown provider route "${provider}"`, 'CLIENT')
      return
    }
    const session = this.deps.sessionFor(provider)
    const identity = this.deps.identityFor(provider)
    const model = baseModelId(options.model)
    const entry = (profile.models ?? []).find(candidate => candidate.id === model)

    // 没有账号是**最常见的「用不了」**：给一句能照着做的错误，而不是让上游回 401。
    // （账号按路由隔离：国内账号不能给海外路由用，反之亦然。）
    const accounts = this.deps.accounts
    if (accounts !== undefined) {
      const picked = accounts.pickForModel(provider)
      if (picked.account === undefined) {
        const others = accounts.all().length
        if (picked.allDrained === true) {
          // 全部账号余额都低于下限：停止使用，点名每个账号的余额，用户自己去充值/等签到回血。
          const detail = picked.drained
            .map(row => `${row.nickname ?? row.uid ?? row.id}：${row.credits}`)
            .join('，')
          yield errorChunk(
            `所有 ${profile.label} 账号的积分都已低于 ${accounts.creditFloor}，本路由停止使用（${detail}）。等每日签到回血或充值后自动恢复。`,
            'CLIENT',
          )
        } else {
          yield errorChunk(
            others === 0
              ? `还没有登录账号：打开「设置 → WorkBuddy 账号」登录一个（当前路由 ${profile.label}）`
              : `路由 ${profile.label} 下没有账号：你登录的 ${others} 个账号属于另一个平台，请在这个路由下也登录一个`,
            'CREDENTIAL',
          )
        }
        return
      }
    }

    let credentials
    try {
      credentials = await session.ensureAuth({ signal: options.signal })
    } catch (error) {
      yield errorChunk(error instanceof Error ? error.message : String(error), 'CREDENTIAL')
      return
    }
    if (credentials.accessToken === undefined) {
      yield errorChunk(`没有可用的 ${profile.label} 凭据（token 缺失或已过期）`, 'CREDENTIAL')
      return
    }
    if (profile.deviceToken && session.deviceToken() === undefined) {
      // 国内版的一设备一账号：没有 device token 就**不发假的**，按纯 JWT 走。
      // 实测（2026-10-21）国内 chat 端点在没有 device token 时依然 200 并正常流式，
      // 所以这条只记 debug，不当成故障——它只在平台真的收紧时才需要补。
      this.logger.debug?.(`workbuddy: ${profile.label} 未配置 x-device-token，本次按纯 JWT 出站`)
    }

    // ── 请求体 ────────────────────────────────────────────────────────────────
    const repaired = repairToolPairing(options.messages ?? [])
    const projected = toChatMessages(repaired, {
      onImageDropped: reason => this.logger.debug?.(`workbuddy: dropped an image block (${reason}); 该路由暂不做视觉内联`),
    })
    const tools = toToolDefs(options.tools ?? [])
    // 内容安全降级期：直接把 system 换成中性提示词，不再先撞一次 400。
    const degraded = this.degrade.isActive(provider)
    const sanitized = sanitizeOutbound({
      system: degraded ? undefined : options.system,
      messages: projected,
      options: this.deps.config.sanitize ?? {},
    })
    const messages = [...sanitized.messages]
    if (degraded) {
      // neutralizeChatBody 返回处理后的对象：拿回它的 messages，别指望原地改本地数组。
      messages.splice(0, messages.length, ...neutralizeChatBody({ messages }).messages)
    } else if (typeof sanitized.system === 'string' && sanitized.system !== '') {
      const first = messages[0]
      if (first?.role === 'system') messages[0] = { role: 'system', content: `${sanitized.system}\n\n${first.content}` }
      else messages.unshift({ role: 'system', content: sanitized.system })
    }

    const chain = identity.chainFor(options.sessionId, this.deps.config.conversationIdFormat)
    const body = {
      model: entry?.id ?? model,
      messages,
      stream: true,
    }
    // 官方客户端用会话 id + previous_response_id 串同一条对话；这也是上游做额度/风控计账的键。
    body.conversation_id = chain.conversationId
    const previous = identity.previousResponseId(chain.key)
    if (previous !== undefined) body.previous_response_id = previous
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature
    const maxTokens = Number(options.maxTokens) || Number(entry?.maxOutput) || Number(this.deps.config.maxTokens) || DEFAULT_MAX_OUTPUT
    body.max_tokens = maxTokens
    if (entry?.vision === true && needsVision(repaired)) body.modalities = ['text', 'image']
    if (entry?.requireEffort === true && options.reasoningEffort === undefined) {
      // glm-5.1 不带 reasoning_effort 会被上游拒（code 11150），官方客户端会补一个默认档。
      body.reasoning_effort = 'medium'
    }
    if (typeof options.reasoningEffort === 'string') {
      body.reasoning_effort = EFFORT_MAP[options.reasoningEffort] ?? options.reasoningEffort
    }
    for (const [key, value] of Object.entries(this.deps.config.bodyExtras ?? {})) body[key] = value

    const headers = buildHeaders({
      profile,
      auth: credentials,
      deviceToken: session.deviceToken(),
      session: chain,
      stream: true,
      userAgent: this.deps.config.userAgent,
      extra: this.deps.config.headerExtras,
    })

    this.deps.record?.({
      at: Date.now(),
      provider,
      model: body.model,
      endpoint: `${profile.endpoint}${profile.chatPath}`,
      headerNames: Object.keys(headers),
      body,
      sanitize: sanitized.report,
    })

    // ── 出站 ──────────────────────────────────────────────────────────────────
    try {
      const response = await openStream({
        url: `${profile.endpoint}${profile.chatPath}`,
        method: 'POST',
        headers,
        body,
        signal: options.signal,
        timeoutMs: Number(this.deps.config.requestTimeoutMs ?? 120_000),
        gzipThresholdBytes: Number(this.deps.config.gzipThresholdBytes ?? 4096),
        keepAlive: this.deps.config.keepAlive !== false,
      })
      const reader = readChatStream(response.lines, {
        onResponseId: id => identity.noteResponseId(chain.key, id),
      })
      let last
      while (true) {
        const row = await reader.next()
        if (row.done === true) {
          last = row.value
          break
        }
        yield row.value
      }
      if (last !== undefined && last.sawText !== true && last.sawReasoning !== true && last.sawToolCall !== true && last.sawFinish !== true) {
        // HTTP 200 但一帧不给：上游对超长上下文的一种「静默拒绝」形状。
        yield errorChunk('upstream answered 200 with no stream frames', 'EMPTY_RESPONSE')
        return
      }
      // 记下这一轮**真实扣掉的积分**（末帧 usage.credit；免费模型就是 0）。
      // 设置页会把它显示成「上次消耗」，这比「倍率 × token」的估算可靠。
      const account = this.deps.accounts?.active?.(provider)
      if (account !== undefined && last !== undefined && (last.credit !== undefined || last.usage !== undefined)) {
        this.deps.accounts.recordUsage(account.id, {
          model: body.model,
          credit: last.credit,
          inputTokens: last.usage?.inputTokens,
          outputTokens: last.usage?.outputTokens,
        })
        if (last.credit !== undefined) {
          this.logger.debug?.(`workbuddy: ${body.model} 本轮消耗 ${last.credit} 积分（账号 ${account.nickname ?? account.uid ?? account.id}）`)
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield abortChunk('aborted', error)
        return
      }
      const failure = toLlmFailure(error)
      // 内容安全拒答（unapproved channel / blocked by security policy）：拦的是 system
      // 提示词的内容，不是账号也不是凭据——换号重发照样 400。解法：删掉客户端 system，
      // 换内置中性提示词**同请求内重试一次**；仍被拦说明用户内容自己撞了审核，如实上抛。
      if (isSecurityRejection(failure.message) && options.securityRetry !== true && this.deps.config.promptMode !== 'passthrough') {
        const until = this.degrade.engage(provider)
        this.logger.warn?.(`workbuddy: 上游按内容安全策略拒掉了本次 system（${failure.message}）；已降级为中性提示词重试，并持续到 ${new Date(until).toISOString()}`)
        yield* this.runStream({ ...options, securityRetry: true })
        return
      }
      if (failure.code === 'CREDENTIAL'
        && options.retryAfterAuth !== true
        && this.deps.config.autoRefresh !== false
        && (await session.refresh())) {
        this.logger.debug?.('workbuddy: retried once after a credential rejection')
        yield* this.runStream({ ...options, retryAfterAuth: true })
        return
      }
      // 上游点名「积分/额度不足」（402 或余额文案）：这个账号的已知余额直接归零，
      // 于是下一次调用就会被积分闸门切到别的账号——不需要再猜，也不浪费请求。
      if (this.deps.accounts !== undefined && isBalanceExhausted(failure)) {
        const drainedAccount = this.deps.accounts.active(provider)
        if (drainedAccount !== undefined && Number.isFinite(Number(drainedAccount.credits))) {
          this.deps.accounts.update(drainedAccount.id, { credits: 0, creditsAt: Date.now(), lastError: { at: Date.now(), message: failure.message } })
          this.logger.warn?.(`workbuddy: 上游报 ${drainedAccount.nickname ?? drainedAccount.id} 额度不足，已按 0 记账并交给积分闸门切换`)
        }
      }
      yield { type: 'finish', reason: { kind: 'error', failure } }
    }
  }
}

/** 把上游的默认思考档归一成我们声明的三个 id 之一。 */
function normaliseEffort(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'low' || text === 'minimal') return 'low'
  if (text === 'high' || text === 'xhigh' || text === 'max') return 'high'
  return 'medium'
}

/** 把任意异常压成 DSH 的失败对象。 */
function toLlmFailure(error) {
  if (error instanceof TransportError) {
    const failure = { message: error.message, code: error.code }
    if (error.status !== undefined) failure.status = error.status
    if (error.providerRetryAfterMs !== undefined) failure.providerRetryAfterMs = error.providerRetryAfterMs
    if (error.requestId !== undefined) failure.requestId = error.requestId
    return failure
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.code === 'string' ? error.code : 'SERVER',
  }
}

function errorChunk(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

function abortChunk(message, cause) {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message, code: 'ABORTED', ...(cause instanceof Error ? { detail: cause.message } : {}) } },
  }
}

export { PLATFORMS }