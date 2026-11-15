/**
 * 国内账号的「成长 / 积分」车道。
 *
 * 这一层不碰推理，只做每天给你涨积分的那些控制面调用。路径与语义来自该生态的
 * 公开逆向记录（见 README「事实来源」），端点分三个域，每个域认的客户端指纹不同，
 * 所以这里按 `flavor` 分别构造头：
 *
 * | 用途 | 路径 | 域 | flavor |
 * |---|---|---|---|
 * | 每日签到（+100，连登第 7 天 +1000） | `POST /billing/meter/daily-checkin` | `www.codebuddy.cn`（回落 `copilot.tencent.com`） | desktop |
 * | 积分余额 | `POST /billing/meter/get-user-resource` | 同上 | desktop |
 * | 对话活跃上报（点亮连登 / 解锁领养） | `POST /report` | `copilot.tencent.com` | cli |
 * | 连登天数与档位 | `GET /activity/growth/streak` | `copilot.tencent.com` | desktop |
 * | 档位兑换 / 抽奖 | `POST /activity/growth/redeem`、`/lottery/summary`、`/lottery/draw` | `copilot.tencent.com` | desktop |
 * | 成长任务列表（只读展示） | `GET /activity/growth/tasks` | `copilot.tencent.com` | desktop |
 *
 * 幂等：签到已领时上游回 `code 10001 / 14001`，这里归一成 `already: true`，
 * 不算失败、不重试。所有调用都**不会**因为失败而丢弃账号——失败只记录原因。
 *
 * @module src/growth.js
 */

import { jsonRequest } from './http.js'
import { extractMessage, unwrapEnvelope } from './identity.js'
import { runGrowthTasks } from './tasks.js'
import { CN_USER_AGENT, PLATFORMS } from './platform.js'

/** 签到 / 余额域：首选域名不通时回落。 */
export const BILLING_BASES = Object.freeze(['https://www.codebuddy.cn', 'https://copilot.tencent.com'])
/** 成长任务与领奖域。 */
export const CLAIM_BASE = 'https://www.workbuddy.cn'

/** 已签到的上游码。 */
export const ALREADY_CHECKIN_CODES = Object.freeze([10001, 14001])

/** 活跃上报的候选路径（真实路径是 `/v2/report`，实测 `/report` 为 404）。 */
export const ACTIVITY_PATHS = Object.freeze(['/v2/report', '/report'])

/** 控制面 UA（CLI 指纹车道用）。 */
export const CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * 从 accessToken 里取上游 userId。
 *
 * 上游控制面认的是 JWT 的 `sub`（uuid 形式），不是账号池里的本地 id。
 * 账号池旧记录只存了 token、没存 uid 时，这里补出来——同一条凭据，同一个值。
 *
 * @param {string|undefined} token
 * @returns {string|undefined}
 */
export function userIdFromToken(token) {
  if (typeof token !== 'string' || token === '') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const sub = payload?.sub
    if (typeof sub !== 'string' || sub === '') return undefined
    return sub
  } catch {
    return undefined
  }
}

/**
 * 控制面头。
 *
 * @param {object} input
 * @param {'desktop'|'cli'|'web'} input.flavor
 * @param {{accessToken?: string, uid?: string, domain?: string, enterpriseId?: string}} input.auth
 * @param {string|undefined} [input.deviceToken]
 * @param {object} [input.config] - 插件 config
 * @param {string} [input.platform] - `codebuddy`（默认）/ `workbuddy`；决定 UA / 产品头取哪个平台的档案
 */
export function controlHeaders({ flavor, auth, deviceToken, config = {}, platform = 'codebuddy' }) {
  const profile = PLATFORMS[platform] ?? PLATFORMS.codebuddy
  const headers = {
    'user-agent': flavor === 'cli' ? (config.cliUserAgent ?? CLI_UA) : (config.userAgent ?? profile.userAgent),
    'x-product': profile.product,
    'x-product-version': profile.productVersion,
    'x-ide-type': profile.ideType,
    'x-ide-name': profile.ideName,
    'x-ide-version': flavor === 'web' ? profile.ideVersion : profile.ideVersion,
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (auth?.accessToken) headers.authorization = `Bearer ${auth.accessToken}`
  if (auth?.uid) headers['x-user-id'] = String(auth.uid)
  if (auth?.domain) headers['x-domain'] = String(auth.domain)
  if (auth?.enterpriseId) {
    headers['x-enterprise-id'] = String(auth.enterpriseId)
    headers['x-tenant-id'] = String(auth.enterpriseId)
  }
  if (deviceToken) headers['x-device-token'] = deviceToken
  if (flavor === 'web') {
    // 领奖接口在 web 域，且要求 web 客户端指纹。
    headers['x-client-platform'] = 'web'
    headers.origin = CLAIM_BASE
    headers.referer = `${CLAIM_BASE}/`
  }
  return headers
}

function codeOf(payload) {
  const value = payload?.code ?? payload?.errCode ?? payload?.errorCode
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

/**
 * 宽松数字：上游的数值字段会在 number / string 之间抖动——余额一旦过千，
 * 计费域的 `*Precise` 变体和某些账号路径会把 `1046` 下发成 `"1,046"`（带千分位逗号）。
 * `Number("1,046")` 是 NaN，`parseFloat` 得 1——积分直接塌成个位数，
 * 看起来就是「超过 1000 的余额显示不出来」。这里统一清洗：去逗号/空白/全角数字。
 */
function toNumberLoose(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(/[\s,]/g, '')
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  if (cleaned === '') return undefined
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : undefined
}

function firstNumber(payload, keys) {
  for (const key of keys) {
    const num = toNumberLoose(payload?.[key])
    if (num !== undefined) return num
  }
  return undefined
}

/**
 * 剥到真正的数据层。
 *
 * `unwrapEnvelope` 只在顶层键 ≤3 时才剥 `data`，而成长域的回包是
 * `{code, msg, requestId, data}` 四个键 —— 永远剥不到。
 * 结果就是 `payload.chances` / `payload.streak` 全是 undefined，
 * 抽奖永远被判成「0 次」，连登天数永远取不到。这里先按 code/msg 认出外壳再取 data。
 */
function dataOf(payload) {
  const outer = unwrapEnvelope(payload)
  if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) return outer ?? {}
  const record = /** @type {Record<string, unknown>} */ (outer)
  const inner = record.data
  if (inner !== null && typeof inner === 'object' && ('code' in record || 'msg' in record)) {
    return inner
  }
  return record
}

/**
 * 每日签到。
 *
 * @param {object} input
 * @param {object} input.session - 已确保新鲜的凭据 `{accessToken, uid, domain, enterpriseId}`
 * @param {string} [input.deviceToken]
 * @param {object} [input.config]
 * @param {AbortSignal} [input.signal]
 * @param {'codebuddy'|'workbuddy'} [input.platform] - 余额/签到按**账号所属平台**的域名与指纹发
 * @returns {Promise<{ok: boolean, already: boolean, credit?: number, streakDays?: number, message: string}>}
 */
export async function dailyCheckin({ session, deviceToken, config = {}, signal, platform = 'codebuddy' }) {
  const bases = billingBases(platform, config)
  let lastMessage = ''
  for (const base of bases) {
    try {
      const response = await jsonRequest({
        url: `${String(base).replace(/\/+$/, '')}/billing/meter/daily-checkin`,
        method: 'POST',
        headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config, platform }),
        body: {},
        timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
        signal,
        keepAlive: false,
      })
      const payload = unwrapEnvelope(response.json) ?? {}
      const code = codeOf(payload) ?? codeOf(response.json)
      if (code !== undefined && ALREADY_CHECKIN_CODES.includes(code)) {
        return { ok: true, already: true, message: '今天已经领过了' }
      }
      const credit = firstNumber(payload, ['credit', 'credits', 'creditAdded', 'amount'])
      const streakDays = firstNumber(payload, ['streak_days', 'streakDays', 'streak'])
      return {
        ok: true,
        already: false,
        ...(credit === undefined ? {} : { credit }),
        ...(streakDays === undefined ? {} : { streakDays }),
        message: credit === undefined ? '签到成功' : `签到成功 +${credit}`,
      }
    } catch (error) {
      lastMessage = extractMessage(error) || (error instanceof Error ? error.message : String(error))
      // 「今天已签到」在上游是**HTTP 400**（实测国内账号的真实答复），不是 code 10001，
      // 所以必须按文案识别，否则每天第二次运行都会记成失败。
      if (/已签到|明天再来|already\s*(checked|signed|claimed)/i.test(lastMessage)) {
        return { ok: true, already: true, message: '今天已经领过了' }
      }
      // 国际版实测（2026-10-30）：`10001 · 签到活动未开启或已过期`——活动对该平台
      // 没开。这不是失败也不是领过，如实转述，且不再对同一天重试。
      if (/未开启|已过期|not\s+(enabled|started)|activity.*(expired|not\s+available)/i.test(lastMessage)) {
        return { ok: true, already: false, unavailable: true, message: `该平台未开启签到活动（上游：${lastMessage.replace(/^.*?(?=签到|code|\d{5})/, '')}）` }
      }
      // 401 说明凭据问题，换域名也没用；其余（404/405 之类的域差异）继续回落尝试。
      if (error?.status === 401 || error?.code === 'CREDENTIAL') break
    }
  }
  return { ok: false, already: false, message: lastMessage || '签到失败' }
}

/** 平台 -> 计费域候选。国际版的计费就在 www.workbuddy.ai（实测 200）。 */
function billingBases(platform, config) {
  if (platform === 'workbuddy') return [PLATFORMS.workbuddy.endpoint]
  return Array.isArray(config.checkinBases) && config.checkinBases.length > 0 ? config.checkinBases : BILLING_BASES
}

/** 积分余额。
 *
 * 真实报文（实测）是一份**腾讯计费资源包列表**，不是平的 `credits` 字段：
 *
 * ```jsonc
 * { "code": 0, "data": { "Response": { "Data": {
 *     "TotalCount": 11, "TotalDosage": 785,
 *     "Accounts": [{ "CapacityUnit": "credits", "CapacityRemain": 0,
 *                    "CapacityUsed": 1500, "CapacitySize": 1500,
 *                    "PackageName": "…拉新权益包", "ExpiredTime": "2026-10-14 10:50:17" }] } } } }
 * ```
 *
 * 所以余额 = `TotalDosage`（上游自己汇总的剩余），拿不到就退化成逐包 `CapacityRemain` 求和。
 * 同时把「最近会过期的那些包」带出来：积分按到期日作废，这一点用户必须看得见。
 */
export async function userResource({ session, deviceToken, config = {}, signal, platform = 'codebuddy' }) {
  const bases = billingBases(platform, config)
  let lastMessage = ''
  for (const base of bases) {
    try {
      const response = await jsonRequest({
        url: `${String(base).replace(/\/+$/, '')}/billing/meter/get-user-resource`,
        method: 'POST',
        headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config, platform }),
        body: {},
        timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
        signal,
        keepAlive: false,
      })
      const parsed = parseResourcePayload(response.json)
      if (parsed === undefined) {
        lastMessage = '上游响应里没有可识别的资源包结构'
        continue
      }
      return { ok: true, ...parsed, message: `剩余 ${parsed.credits} 积分` }
    } catch (error) {
      lastMessage = extractMessage(error) || (error instanceof Error ? error.message : String(error))
      if (error?.status === 401 || error?.code === 'CREDENTIAL') break
    }
  }
  return { ok: false, message: lastMessage || '余额查询失败' }
}

/**
 * 解析计费资源包响应。
 *
 * @param {unknown} payload
 * @returns {{credits: number, used?: number, packages?: object[]}|undefined}
 */
export function parseResourcePayload(payload) {
  const data = payload?.data?.Response?.Data
    ?? payload?.Response?.Data
    ?? payload?.data?.data
    ?? unwrapEnvelope(payload)
  const rows = Array.isArray(data?.Accounts) ? data.Accounts
    : Array.isArray(data?.accounts) ? data.accounts
      : Array.isArray(data) ? data : undefined
  const total = firstNumber(data ?? {}, ['TotalDosage', 'totalDosage'])
  if (rows === undefined && total === undefined) return undefined
  const creditRows = (rows ?? []).filter(row => String(row?.CapacityUnit ?? row?.OriginUnit ?? 'credits').toLowerCase() === 'credits')
  const remain = creditRows.reduce((sum, row) => sum + (toNumberLoose(row?.CapacityRemain) ?? 0), 0)
  const used = creditRows.reduce((sum, row) => sum + (toNumberLoose(row?.CapacityUsed) ?? 0), 0)
  const credits = total !== undefined ? total : remain
  const packages = creditRows
    .map(row => ({
      name: typeof row?.PackageName === 'string' ? row.PackageName : undefined,
      remain: toNumberLoose(row?.CapacityRemain) ?? 0,
      size: toNumberLoose(row?.CapacitySize) ?? undefined,
      expiresAt: typeof row?.ExpiredTime === 'string' ? row.ExpiredTime : undefined,
    }))
    .filter(row => row.remain > 0)
    .sort((a, b) => String(a.expiresAt ?? '9999').localeCompare(String(b.expiresAt ?? '9999')))
    .slice(0, 5)
  return { credits, used, packages }
}

/**
 * 对话活跃上报：每天一条即可点亮连登（并解锁领养前置）。
 *
 * body 是一个**事件数组**，事件类型 `chat_request_send`，且必须带 `userId`。
 */
export async function reportActivity({ session, config = {}, signal }) {
  // 上游认的是 userId，不是账号 id。账号池里旧记录可能只有 accessToken 没存 uid，
  // 这时从 JWT 的 `sub` 取——那里就是上游真正的 userId，权威口径。
  const userId = session.uid ?? session.userId ?? userIdFromToken(session.accessToken)
  if (userId === undefined) return { ok: false, message: '缺少 userId，无法上报活跃' }
  const timestamp = Date.now()
  const conversationId = config.activityConversationId ?? `wb-${timestamp}`
  // 事件形状是上游**逐条报出来**的：先要 `eventCode`（字符串），
  // 再要 `timestamp`（或 `reportDelay`）。实测 `{eventCode, userId, timestamp}` 回 200。
  const events = [
    {
      eventCode: 'chat_request_send',
      userId,
      timestamp,
      conversationId,
      requestId: `${conversationId}-1`,
    },
  ]
  try {
    // `/v2/report` 才是行为上报的真实路径（实测 `/report` 返回 404）；两个都留作候选，
    // 因为这条路径在该生态里换过位置。
    let lastMessage = ''
    for (const path of ACTIVITY_PATHS) {
      try {
        const response = await jsonRequest({
          url: `${PLATFORMS.codebuddy.endpoint}${path}`,
          method: 'POST',
          headers: controlHeaders({ flavor: 'cli', auth: session, deviceToken: undefined, config }),
          body: events,
          timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
          signal,
          keepAlive: false,
        })
        const payload = unwrapEnvelope(response.json) ?? {}
        const code = codeOf(payload)
        if (code !== undefined && code !== 0) {
          return { ok: false, message: `上游 code ${code}${extractMessage(payload) ? ` · ${extractMessage(payload)}` : ''}` }
        }
        return { ok: true, message: '活跃已上报', path }
      } catch (error) {
        lastMessage = `${path}: ${extractMessage(error) || (error instanceof Error ? error.message : String(error))}`
        if (error?.status !== 404) break
      }
    }
    return { ok: false, message: lastMessage || '活跃上报失败' }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 上游幂等键：`/redeem` 与 `/lottery/draw` 都按它去重，同一个 token 重复提交只会
 * 命中 idempotent_hit 而不消耗次数。所以每次动作必须一个新值。
 */
export function newClientToken(prefix = 'wb') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 连登天数与档位状态。
 *
 * 真实报文（实测 2026-11-12）：
 * ```jsonc
 * { "code":0, "data": {
 *     "streak": { "days": 12, "month_total_days": 12, "next_tier": "14d", "next_tier_remaining": 2 },
 *     "makeup_cards": { "balance": 0, "max": 4 },
 *     "redemption_status": {
 *       "tier_7d_count": 0, "tier_14d_count": 0, "tier_28d_count": 0,
 *       "tier_7d_status": "available", "tier_14d_status": "locked", "tier_28d_status": "locked",
 *       "remaining_days": 12,
 *       "tiers": [ { "tier":"7d","days":7,"credit":0,"energy":2,"cards":1,"chances":1 }, … ] } } }
 * ```
 * 天数在 `data.streak.days`，**档位解锁状态在 `redemption_status.tier_XXd_status`**，
 * `tiers[]` 里只有奖励额度、没有状态 —— 只看 tiers 会把每一档都判成「未解锁」。
 */
export async function growthStreak({ session, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/streak`,
      method: 'GET',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = dataOf(response.json) ?? {}
    const streakNode = payload?.streak ?? payload
    const days = firstNumber(streakNode, ['days', 'streakDays', 'streak_days'])
    const redemption = payload?.redemption_status ?? payload?.redemptionStatus
    const rawTiers = Array.isArray(redemption?.tiers) ? redemption.tiers
      : (Array.isArray(payload?.tiers) ? payload.tiers : (Array.isArray(payload?.streak_tiers) ? payload.streak_tiers : []))
    const tiers = rawTiers.map((row) => {
      const tier = row.tier ?? row.id ?? row.days ?? row.level
      const key = String(tier).replace(/d$/i, '')
      const status = row.status
        ?? redemption?.[`tier_${key}d_status`]
        ?? redemption?.[`tier_${key}_status`]
      const count = Number(redemption?.[`tier_${key}d_count`] ?? redemption?.[`tier_${key}_count`] ?? 0) || 0
      return {
        ...row,
        tier,
        status,
        claimed: row.claimed === true || status === 'claimed' || count > 0,
        locked: row.locked === true || status === 'locked',
        unlocked: row.unlocked === true || status === 'available' || status === 'unlocked',
      }
    })
    return { ok: true, days, tiers, raw: payload }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 兑换一个已解锁的连登档位。
 *
 * 真实报文（实测 2026-11-12，`tier` 必须是 `"7d"/"14d"/"28d"` 这种带 d 的字面量）：
 * ```jsonc
 * POST /activity/growth/redeem  { "tier":"7d", "client_token":"wb-…" }
 * → { "code":0, "data": { "redemption_id":4584019, "tier":"7d", "credit_granted":0,
 *      "energy_granted":2, "cards_granted":1, "cards_overflow":0, "chances_granted":1,
 *      "remaining_days":0 } }
 * ```
 * `client_token` 是**必填**幂等键：缺了回 400 `invalid redemption request`；
 * 同一个 token 重发只回 `idempotent_hit`，不重复发放。
 */
export async function redeemTier({ session, tier, clientToken, deviceToken, config = {}, signal }) {
  const token = clientToken ?? newClientToken('wb-redeem')
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/redeem`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: { tier, client_token: token },
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = dataOf(response.json) ?? {}
    const credit = firstNumber(payload, ['credit_granted', 'creditGranted'])
    const energy = firstNumber(payload, ['energy_granted', 'energyGranted'])
    const chances = firstNumber(payload, ['chances_granted', 'chancesGranted'])
    const parts = [
      credit === undefined || credit === 0 ? undefined : `+${credit} 积分`,
      energy === undefined || energy === 0 ? undefined : `+${energy} 能量`,
      chances === undefined || chances === 0 ? undefined : `+${chances} 抽奖`,
    ].filter(Boolean)
    return { ok: true, tier, credit, energy, chances, message: parts.length > 0 ? parts.join(' · ') : `${tier} 已兑换`, raw: payload }
  } catch (error) {
    return { ok: false, tier, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 抽奖次数。
 *
 * 真实报文：`{ "code":0, "data": { "chances": 1, "module": { "enabled": true } } }`
 * —— 字段是 `chances`，不是 `times/count/remaining`。
 */
export async function lotterySummary({ session, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/lottery/summary`,
      method: 'GET',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = dataOf(response.json) ?? {}
    const times = firstNumber(payload, ['chances', 'times', 'count', 'drawTimes', 'remaining'])
    return { ok: true, times, enabled: payload?.module?.enabled !== false, raw: payload }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 抽一次奖。
 *
 * 真实报文（实测 2026-11-12）：
 * ```jsonc
 * POST /activity/growth/lottery/draw { "client_token":"p-…" }
 * → { "code":0, "data": { "draw_uuid":"26236ed9-…", "prize_code":"积分_3",
 *      "prize_name":"10 积分", "prize_type":"credit", "credit_amount":10,
 *      "idempotent_hit":false } }
 * ```
 * 空 body 回 400 `invalid request`；`client_token` 必填，且必须每次新值，否则只回上一次结果。
 */
export async function lotteryDraw({ session, clientToken, deviceToken, config = {}, signal }) {
  const token = clientToken ?? newClientToken('wb-draw')
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/lottery/draw`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: { client_token: token },
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = dataOf(response.json) ?? {}
    const prize = typeof payload?.prize_name === 'string' ? payload.prize_name : undefined
    const idempotent = payload?.idempotent_hit === true
    return {
      ok: true,
      prize,
      prizeType: payload?.prize_type,
      credit: firstNumber(payload, ['credit_amount']),
      idempotent,
      message: prize === undefined ? '抽奖完成' : `抽到 ${prize}${idempotent ? '（重复提交，未消耗次数）' : ''}`,
      raw: payload,
    }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/** 成长任务列表（只读，用于展示）。 */
export async function growthTasks({ session, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/tasks`,
      method: 'GET',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = dataOf(response.json) ?? {}
    const rows = Array.isArray(payload?.tasks) ? payload.tasks : (Array.isArray(payload) ? payload : [])
    return {
      ok: true,
      tasks: rows.map(row => ({
        code: row.task_code ?? row.code ?? row.taskCode ?? null,
        name: row.name ?? row.title ?? null,
        progress: Number(row.progress ?? row.current ?? 0) || 0,
        target: Number(row.target ?? row.total ?? 0) || 0,
        claimed: row.claimed === true || row.status === 'claimed',
        rewardCredit: Number(row.reward_credit ?? row.rewardCredit ?? 0) || 0,
        rewardEnergy: Number(row.reward_energy ?? row.rewardEnergy ?? 0) || 0,
      })),
    }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)), tasks: [] }
  }
}

/**
 * 每日闭环：签到 → （可选）连登兑换 + 抽奖 → 活跃上报 → 余额回读。
 *
 * 顺序是有意的：签到先落账（它同时决定连登天数），再处理靠连登解锁的档位与抽奖，
 * 最后上报活跃并回读余额。任何一步失败都只记进结果，不影响后面的步骤。
 *
 * @param {object} input
 * @param {{uid?: string, accessToken?: string, domain?: string, enterpriseId?: string}} input.session
 * @param {string} [input.deviceToken]
 * @param {object} [input.config]
 * @param {AbortSignal} [input.signal]
 * @param {'codebuddy'|'workbuddy'} [input.platform] - 闭环按**账号所属平台**发：国际版只有余额与（若开启的）签到，
 *   连登 / 抽奖 / 活跃上报是国内成长域独有的，对国际账号一律跳过而不是拿国内域名硬撞。
 */
export async function runDailyGrowth({ session, deviceToken, config = {}, signal, platform = 'codebuddy' }) {
  const result = { at: Date.now(), checkin: undefined, activity: undefined, redeem: [], lottery: undefined, credits: undefined, streakDays: undefined, tiers: undefined }

  result.checkin = await dailyCheckin({ session, deviceToken, config, signal, platform })
  if (result.checkin.streakDays !== undefined) result.streakDays = result.checkin.streakDays

  const autoGrowth = platform === 'codebuddy' && config.autoGrowth !== false
  if (autoGrowth) {
    const streak = await growthStreak({ session, deviceToken, config, signal })
    if (streak.ok === true) {
      if (streak.days !== undefined) result.streakDays = streak.days
      result.tiers = (streak.tiers ?? []).map(tier => ({
        tier: tier.tier ?? tier.days,
        status: tier.status ?? (tier.locked === true ? 'locked' : tier.claimed === true ? 'claimed' : tier.unlocked === true ? 'available' : 'unknown'),
        credit: Number(tier.credit) || 0,
        energy: Number(tier.energy) || 0,
        chances: Number(tier.chances) || 0,
      }))
      for (const tier of streak.tiers ?? []) {
        const locked = tier.locked === true || tier.status === 'locked'
        const claimed = tier.claimed === true || tier.status === 'claimed'
        const unlocked = tier.unlocked === true || tier.status === 'unlocked' || tier.status === 'available'
        if (locked || claimed || !unlocked) continue
        const redeem = await redeemTier({ session, tier: tier.tier ?? tier.id ?? tier.days ?? tier.level, deviceToken, config, signal })
        result.redeem.push({ tier: redeem.tier ?? tier.tier, ok: redeem.ok, message: redeem.message })
      }
      const summary = await lotterySummary({ session, deviceToken, config, signal })
      if (summary.ok === true && Number(summary.times) > 0) {
        const draws = []
        const max = Math.min(Number(summary.times), Number(config.maxLotteryDraws ?? 20))
        for (let index = 0; index < max; index += 1) {
          const draw = await lotteryDraw({ session, deviceToken, config, signal })
          draws.push({ ok: draw.ok, message: draw.message, prize: draw.prize })
          if (draw.ok !== true) break
          // 幂等命中说明上游认为这次没真正消耗次数，继续抽只会拿到同一条结果。
          if (draw.idempotent === true) break
        }
        result.lottery = { times: summary.times, draws }
      } else if (summary.ok === true) {
        result.lottery = { times: summary.times ?? 0, draws: [] }
      }
    }
  }

  // 成长任务：接取 + 领取。进度未达的只报告「需在客户端完成」，绝不伪造。
  // 放在活跃上报之前——有些任务把「发一条对话」当进度，先上报能顺带点亮。
  if (platform === 'codebuddy' && config.autoTasks === true) {
    result.tasks = await runGrowthTasks({
      session,
      deviceToken,
      config,
      signal,
      skipTasks: Array.isArray(config.skipTasks) ? config.skipTasks : [],
    })
  }

  if (platform === 'codebuddy' && config.autoActivity !== false) {
    result.activity = await reportActivity({ session, config, signal })
  }

  const balance = await userResource({ session, deviceToken, config, signal, platform })
  if (balance.ok === true) {
    result.credits = balance.credits
    if (balance.packages !== undefined) result.packages = balance.packages
  }
  return result
}