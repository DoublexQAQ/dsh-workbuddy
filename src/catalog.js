/**
 * 上游模型目录：把「哪些模型免费、倍率多少、多长上下文、能不能思考」读成结构化事实。
 *
 * 两条真实来源（都已实测，见 test/probe-models.mjs）：
 *
 * - `GET /console/enterprises/personal/models`（`copilot.tencent.com`）——**主用**，
 *   返回 34 个国内模型的完整矩阵，含 `credits` 倍率、`maxInputTokens` / `maxOutputTokens`、
 *   `supportsImages` / `supportsToolCall` / `supportsReasoning`、`reasoning.effort`、`vendor`。
 * - `GET /v3/config?repos=`——回落（24 个模型），字段形状一致。
 *
 * `credits` 的真实写法有两种携带方式：`"x0.29"` 与 `"x0.00 credits"`。`x0.00` 就是**免费**。
 *
 * 目录按 `route + 账号` 缓存：倍率是**按账号权限**下发的（付费号能看到更多模型），
 * 所以缓存键里必须带账号，否则会把甲的可见模型表用在乙身上。
 *
 * @module src/catalog.js
 */

import { jsonRequest } from './http.js'
import { unwrapEnvelope } from './identity.js'
import { PLATFORMS } from './platform.js'

/** 主用与回落路径。 */
export const CATALOG_PATHS = Object.freeze(['/console/enterprises/personal/models', '/v3/config?repos='])

/** 默认缓存时长（毫秒）。 */
export const DEFAULT_CATALOG_TTL_MS = 10 * 60_000

/**
 * 从 `credits` 字段里解出倍率数字。
 *
 * @param {unknown} value - `"x0.29"` / `"x0.00 credits"` / 0.29 / 0
 * @returns {number|undefined} 倍率；`0` 表示免费；无法解析时 undefined
 */
export function parseCredits(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const match = value.match(/x\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (match !== null) {
    const numeric = Number.parseFloat(match[1])
    return Number.isFinite(numeric) ? numeric : undefined
  }
  const plain = Number.parseFloat(value)
  return Number.isFinite(plain) ? plain : undefined
}

/**
 * 倍率 -> 人读标签。免费就是免费，别拿 `×0.00` 糊弄。
 *
 * @param {number|undefined} credits
 * @returns {string} 例如 `免费`、`×0.29`
 */
export function priceTag(credits) {
  if (credits === undefined) return '倍率未知'
  if (credits === 0) return '免费'
  return `×${credits}`
}

/**
 * 一行上游模型记录 -> 插件内部的行。
 *
 * @param {object} row
 * @param {number} [creditsOverride]
 */
export function normalizeModelRow(row, creditsOverride) {
  const credits = creditsOverride ?? parseCredits(row?.credits)
  const reasoning = row?.reasoning ?? undefined
  const supportedLengths = Array.isArray(row?.contextWindow?.supportedLengths)
    ? row.contextWindow.supportedLengths.filter(value => Number.isFinite(Number(value))).map(Number)
    : []
  const maxInput = Number(row?.maxInputTokens ?? row?.maxAllowedSize ?? row?.contextWindow?.defaultLength) || undefined
  const maxOutput = Number(row?.maxOutputTokens) || undefined
  return {
    id: String(row?.id ?? ''),
    name: String(row?.name ?? row?.id ?? ''),
    credits,
    free: credits === 0,
    vendor: typeof row?.vendor === 'string' ? row.vendor : undefined,
    description: typeof row?.descriptionZh === 'string' && row.descriptionZh !== '' ? row.descriptionZh
      : typeof row?.descriptionEn === 'string' && row.descriptionEn !== '' ? row.descriptionEn : undefined,
    contextWindow: maxInput,
    supportedContexts: supportedLengths.length > 0 ? supportedLengths : undefined,
    maxOutput,
    vision: row?.supportsImages === true,
    tools: row?.supportsToolCall !== false,
    thinking: row?.supportsReasoning === true || row?.onlyReasoning === true,
    thinkingMandatory: row?.onlyReasoning === true,
    defaultEffort: typeof reasoning?.effort === 'string' ? reasoning.effort : undefined,
    isDefault: row?.isDefault === true,
  }
}

/**
 * 目录缓存：`route + accountId -> {rows, at}`。
 */
export class ModelCatalog {
  /**
   * @param {object} input
   * @param {number} [input.ttlMs]
   * @param {{debug?: Function, warn?: Function}} [input.logger]
   */
  constructor({ ttlMs = DEFAULT_CATALOG_TTL_MS, logger } = {}) {
    this.ttlMs = ttlMs
    this.logger = logger ?? {}
    /** @type {Map<string, {rows: object[], at: number, error?: string}>} */
    this.cache = new Map()
  }

  /**
   * 取一个账号可见的模型表（带缓存；`force` 强制刷新）。
   *
   * @param {object} input
   * @param {string} input.route
   * @param {object} input.account
   * @param {object} input.auth - `{accessToken, uid, domain, enterpriseId}`
   * @param {object} [input.config]
   * @param {AbortSignal} [input.signal]
   * @param {boolean} [input.force]
   * @returns {Promise<{rows: object[], at: number, error?: string}>}
   */
  async get({ route, account, auth, config = {}, signal, force = false }) {
    const key = `${route}:${account?.id ?? 'anon'}`
    const cached = this.cache.get(key)
    if (force !== true && cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached
    const fetched = await this.fetch({ route, auth, config, signal })
    this.cache.set(key, fetched)
    return fetched
  }

  /** 同步读缓存（模型选择器渲染时用，绝不因为一次网络往返卡住选择器）。 */
  peek({ route, account }) {
    return this.cache.get(`${route}:${account?.id ?? 'anon'}`)
  }

  async fetch({ route, auth, config = {}, signal }) {
    const profile = PLATFORMS[route]
    if (profile === undefined) return { rows: [], at: Date.now(), error: `unknown route ${route}` }
    const headers = {
      'user-agent': config.userAgent ?? profile.userAgent,
      'x-product': profile.product,
      'x-product-version': profile.productVersion,
      'x-ide-type': profile.ideType,
      'x-ide-name': profile.ideName,
      'x-ide-version': profile.ideVersion,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(auth?.accessToken ? { authorization: `Bearer ${auth.accessToken}` } : {}),
      ...(auth?.uid ? { 'x-user-id': String(auth.uid) } : {}),
      ...(auth?.domain ? { 'x-domain': String(auth.domain) } : {}),
      ...(auth?.enterpriseId ? { 'x-enterprise-id': String(auth.enterpriseId), 'x-tenant-id': String(auth.enterpriseId) } : {}),
    }
    let lastError
    for (const candidate of CATALOG_PATHS) {
      try {
        const response = await jsonRequest({
          url: `${profile.endpoint}${candidate}`,
          method: 'GET',
          headers,
          timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
          signal,
          keepAlive: false,
        })
        const rows = readModelRows(response.json)
        if (rows.length > 0) {
          this.logger.debug?.(`workbuddy: ${route} 模型目录 ${rows.length} 行（${candidate}）`)
          return { rows, at: Date.now() }
        }
        lastError = `${candidate} 返回 0 行`
      } catch (error) {
        lastError = `${candidate}: ${error?.status ?? ''} ${error?.message ?? error}`.trim()
        // 401 换路径也没用（问题在凭据），直接收口。
        if (error?.status === 401 || error?.code === 'CREDENTIAL') break
      }
    }
    this.logger.debug?.(`workbuddy: ${route} 模型目录读取失败（${lastError ?? '未知原因'}）`)
    return { rows: [], at: Date.now(), error: lastError ?? 'unknown' }
  }
}

/**
 * 从任意信封形状里取出模型行数组。
 *
 * @param {unknown} payload
 * @returns {object[]}
 */
export function readModelRows(payload) {
  const unwrapped = unwrapEnvelope(payload)
  const candidates = [
    unwrapped?.models,
    payload?.models,
    unwrapped?.data?.models,
    payload?.data?.models,
    Array.isArray(unwrapped) ? unwrapped : undefined,
    Array.isArray(payload?.data) ? payload.data : undefined,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate
        .filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
        .map(row => normalizeModelRow(row))
    }
  }
  return []
}

/**
 * 模型选择器里显示的名字：把「免费 / 倍率」直接写进名字。
 *
 * DSH 的模型选择器**按 provider 分组、只稳定显示 name**（description 不一定有位置），
 * 所以计价信息必须进 name 才算「看得见」。
 *
 * @param {object} row
 * @returns {string}
 */
export function displayName(row) {
  const base = row?.name ?? row?.id ?? ''
  const tag = priceTag(row?.credits)
  return base === '' ? tag : `${base} · ${tag}`
}

/**
 * 模型选择器里的说明行：上下文 / 输出 / 思考 / 厂商。
 *
 * @param {object} row
 * @returns {string}
 */
export function displayDescription(row) {
  const parts = []
  if (row?.contextWindow !== undefined) parts.push(`上下文 ${Math.round(row.contextWindow / 1000)}K`)
  if (row?.maxOutput !== undefined) parts.push(`输出 ${Math.round(row.maxOutput / 1000)}K`)
  if (row?.vision === true) parts.push('视觉')
  if (row?.thinking === true) parts.push(row?.thinkingMandatory === true ? '强制思考' : '可调思考')
  if (row?.vendor !== undefined) parts.push(row.vendor)
  if (parts.length === 0) parts.push(priceTag(row?.credits))
  return parts.join(' · ')
}