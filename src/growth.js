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
 * 控制面头。
 *
 * @param {object} input
 * @param {'desktop'|'cli'|'web'} input.flavor
 * @param {{accessToken?: string, uid?: string, domain?: string, enterpriseId?: string}} input.auth
 * @param {string|undefined} [input.deviceToken]
 * @param {object} [input.config] - 插件 config
 */
export function controlHeaders({ flavor, auth, deviceToken, config = {} }) {
  const profile = PLATFORMS.codebuddy
  const headers = {
    'user-agent': flavor === 'cli' ? (config.cliUserAgent ?? CLI_UA) : (config.userAgent ?? CN_USER_AGENT),
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

function firstNumber(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key]
    if (Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

/**
 * 每日签到。
 *
 * @param {object} input
 * @param {object} input.session - 已确保新鲜的凭据 `{accessToken, uid, domain, enterpriseId}`
 * @param {string} [input.deviceToken]
 * @param {object} [input.config]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ok: boolean, already: boolean, credit?: number, streakDays?: number, message: string}>}
 */
export async function dailyCheckin({ session, deviceToken, config = {}, signal }) {
  const bases = Array.isArray(config.checkinBases) && config.checkinBases.length > 0 ? config.checkinBases : BILLING_BASES
  let lastMessage = ''
  for (const base of bases) {
    try {
      const response = await jsonRequest({
        url: `${String(base).replace(/\/+$/, '')}/billing/meter/daily-checkin`,
        method: 'POST',
        headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
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
      // 401 说明凭据问题，换域名也没用；其余（404/405 之类的域差异）继续回落尝试。
      if (error?.status === 401 || error?.code === 'CREDENTIAL') break
    }
  }
  return { ok: false, already: false, message: lastMessage || '签到失败' }
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
export async function userResource({ session, deviceToken, config = {}, signal }) {
  const bases = Array.isArray(config.checkinBases) && config.checkinBases.length > 0 ? config.checkinBases : BILLING_BASES
  let lastMessage = ''
  for (const base of bases) {
    try {
      const response = await jsonRequest({
        url: `${String(base).replace(/\/+$/, '')}/billing/meter/get-user-resource`,
        method: 'POST',
        headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
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
  const remain = creditRows.reduce((sum, row) => sum + (Number(row?.CapacityRemain) || 0), 0)
  const used = creditRows.reduce((sum, row) => sum + (Number(row?.CapacityUsed) || 0), 0)
  const credits = total !== undefined ? total : remain
  const packages = creditRows
    .map(row => ({
      name: typeof row?.PackageName === 'string' ? row.PackageName : undefined,
      remain: Number(row?.CapacityRemain) || 0,
      size: Number(row?.CapacitySize) || undefined,
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
  const userId = session.uid
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

/** 连登天数与档位状态。 */
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
    const payload = unwrapEnvelope(response.json) ?? {}
    const days = firstNumber(payload, ['days', 'streakDays', 'streak_days'])
    const tiers = Array.isArray(payload?.tiers) ? payload.tiers : (Array.isArray(payload?.streak_tiers) ? payload.streak_tiers : [])
    return { ok: true, days, tiers, raw: payload }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/** 兑换一个已解锁的连登档位。 */
export async function redeemTier({ session, tier, clientToken, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/redeem`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: { tier, client_token: clientToken },
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    return { ok: true, raw: unwrapEnvelope(response.json) }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/** 抽奖次数。 */
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
    const payload = unwrapEnvelope(response.json) ?? {}
    const times = firstNumber(payload, ['times', 'count', 'drawTimes', 'remaining'])
    return { ok: true, times, raw: payload }
  } catch (error) {
    return { ok: false, message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/** 抽一次奖。 */
export async function lotteryDraw({ session, clientToken, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${PLATFORMS.codebuddy.endpoint}/activity/growth/lottery/draw`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: { client_token: clientToken },
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    return { ok: true, raw: unwrapEnvelope(response.json) }
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
    const payload = unwrapEnvelope(response.json) ?? {}
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
 */
export async function runDailyGrowth({ session, deviceToken, config = {}, signal }) {
  const result = { at: Date.now(), checkin: undefined, activity: undefined, redeem: [], lottery: undefined, credits: undefined, streakDays: undefined }

  result.checkin = await dailyCheckin({ session, deviceToken, config, signal })
  if (result.checkin.streakDays !== undefined) result.streakDays = result.checkin.streakDays

  const autoGrowth = config.autoGrowth !== false
  if (autoGrowth) {
    const streak = await growthStreak({ session, deviceToken, config, signal })
    if (streak.ok === true) {
      if (streak.days !== undefined) result.streakDays = streak.days
      const clientToken = config.clientToken
      for (const tier of streak.tiers ?? []) {
        const locked = tier.locked === true || tier.status === 'locked'
        const claimed = tier.claimed === true || tier.status === 'claimed'
        const unlocked = tier.unlocked === true || tier.status === 'unlocked' || tier.status === 'available'
        if (locked || claimed || !unlocked) continue
        const redeem = await redeemTier({ session, tier: tier.tier ?? tier.id ?? tier.days ?? tier.level, clientToken, deviceToken, config, signal })
        result.redeem.push({ tier: tier.tier ?? tier.id ?? tier.days ?? tier.level, ok: redeem.ok, message: redeem.message })
      }
      const summary = await lotterySummary({ session, deviceToken, config, signal })
      if (summary.ok === true && Number(summary.times) > 0) {
        const draws = []
        const max = Math.min(Number(summary.times), Number(config.maxLotteryDraws ?? 20))
        for (let index = 0; index < max; index += 1) {
          const draw = await lotteryDraw({ session, clientToken, deviceToken, config, signal })
          draws.push({ ok: draw.ok, message: draw.message })
          if (draw.ok !== true) break
        }
        result.lottery = { times: summary.times, draws }
      } else if (summary.ok === true) {
        result.lottery = { times: summary.times ?? 0, draws: [] }
      }
    }
  }

  if (config.autoActivity !== false) {
    result.activity = await reportActivity({ session, config, signal })
  }

  const balance = await userResource({ session, deviceToken, config, signal })
  if (balance.ok === true) {
    result.credits = balance.credits
    if (balance.packages !== undefined) result.packages = balance.packages
  }
  return result
}