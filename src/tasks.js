// 新增 src/tasks.js：成长任务自动化（接取 → 进度达标 → 领取）
//
// 接口来自实测参考实现（2026-11 核对，GitHub 多个同生态项目一致）：
//   GET  /v2/activity/growth/tasks              任务列表（progress.current/target）
//   POST /activity/growth/tasks/accept          { task_codes: [code] }  → 接取
//   POST /activity/growth/tasks/{code}/claim    领取（幂等，重复领回 already_claimed）
//   GET  /v2/activity/growth/profile            成长等级（可选）
//
// 状态机：not_accepted --accept--> accepted --(进度达标)--> completed --claim--> claimed
// 铁律：
//   · 付费任务（捐款/公益/充值/购买/订阅付费…）**永不接取、永不领取**，先于一切判定
//   · 用户 skip 名单里的任务同样不碰
//   · 进度未达标只报告「需先在客户端完成」，绝不伪造进度
//   · 幂等/良性回复（already claimed / not completed / expired / locked）算跳过，不算失败
//
// @module src/tasks.js

import { jsonRequest } from './http.js'
import { extractMessage } from './identity.js'
import { controlHeaders } from './growth.js'
import { PLATFORMS } from './platform.js'

export const GROWTH_TASKS_PATH = '/v2/activity/growth/tasks'
export const GROWTH_ACCEPT_PATH = '/activity/growth/tasks/accept'
export const GROWTH_CLAIM_PATH = code => `/activity/growth/tasks/${encodeURIComponent(code)}/claim`
export const GROWTH_PROFILE_PATH = '/v2/activity/growth/profile'

/** 付费任务：一票否决。命中 code 名单或文案关键词都不碰。 */
export const PAID_TASK_CODES = Object.freeze(['Expert_Philanthropy'])
export const PAID_TASK_KEYWORDS = Object.freeze([
  '捐款', '捐赠', '公益', '充值', '付费', '购买', '订阅', '开通会员', '支付',
  'donate', 'subscription', 'purchase', 'payment', 'paid',
])

/** 良性（非失败）领取回复：上游说「没得领」不是错误。 */
export const BENIGN_MESSAGES = Object.freeze([
  'not completed', 'already', 'claimed', 'not arrived', 'expired', 'locked',
  'no unclaimed', 'nothing to claim', 'no reward', '未完成', '已领取', '已过期', '未解锁',
])

export function isPaidTask(task) {
  const code = String(task?.code ?? task?.task_code ?? '')
  if (PAID_TASK_CODES.some(item => item.toLowerCase() === code.toLowerCase())) return true
  const haystack = [task?.title, task?.desc, task?.description, task?.name]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return PAID_TASK_KEYWORDS.some(word => haystack.includes(word.toLowerCase()))
}

export function isBenignMessage(message) {
  const text = String(message ?? '').toLowerCase()
  return BENIGN_MESSAGES.some(word => text.includes(word.toLowerCase()))
}

/** 上游任务行 → 归一形状（字段名在上游有 camel/snake 两套）。 */
export function normalizeTask(row) {
  const progress = row?.progress ?? {}
  const current = Number(progress.current ?? row?.current ?? row?.progress_current ?? 0) || 0
  const target = Number(progress.target ?? row?.target ?? row?.progress_target ?? 0) || 0
  const status = String(row?.accept_status ?? row?.status ?? '').toLowerCase()
  const claimed = row?.claimed === true || status === 'claimed' || status === 'received'
  const done = target > 0 && current >= target
  return {
    code: String(row?.task_code ?? row?.code ?? ''),
    title: row?.title ?? row?.name ?? '',
    desc: row?.task_desc ?? row?.description ?? '',
    status,
    current,
    target,
    progressDone: done,
    claimed,
    claimable: done && !claimed,
    rewardCredit: Number(row?.reward_credit ?? row?.rewardCredit ?? 0) || 0,
    rewardEnergy: Number(row?.reward_energy ?? row?.rewardEnergy ?? 0) || 0,
    paid: isPaidTask(row),
  }
}

function baseUrl() {
  return String(PLATFORMS.codebuddy.endpoint).replace(/\/+$/, '')
}

/** 拉任务列表。 */
export async function fetchTasks({ session, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${baseUrl()}${GROWTH_TASKS_PATH}`,
      method: 'GET',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const payload = response.json?.data ?? response.json ?? {}
    const rows = Array.isArray(payload?.tasks) ? payload.tasks : (Array.isArray(payload) ? payload : [])
    return { ok: true, tasks: rows.map(normalizeTask) }
  } catch (error) {
    return { ok: false, tasks: [], message: extractMessage(error) || (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 接取任务。
 *
 * 上游 `results[].status` 有三种取值（实测 2026-11）：
 *   · `accepted`  —— 本次真的接上了
 *   · `error`     —— **重复接取**（这个任务之前已经接过了）；带着 `error` 字段说明原因。
 *                    这不是失败：任务已在接取态，后面照样能推进进度、照样能领。
 *   · 其它        —— 当作已接取处理（保守，不阻碍后续领取）
 * 所以 `error` 归一到「已接取（重复）」而不是失败——早先把它当失败会误报 3 个任务。
 */
export async function acceptTask({ session, code, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${baseUrl()}${GROWTH_ACCEPT_PATH}`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: { task_codes: [code] },
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const result = response.json?.data?.results?.[0] ?? {}
    const status = String(result.status ?? 'accepted')
    if (status === 'error') {
      const reason = String(result.error ?? result.message ?? '').toLowerCase()
      // 分日解锁：正常现象，如实转述，不算失败。
      if (reason.includes('locked until')) {
        const when = /locked until\s*([0-9-]+)/i.exec(reason)?.[1]
        return { ok: false, benign: true, code, status, message: when === undefined ? '未解锁' : `未解锁（${when} 开启）` }
      }
      // 其余 error 都是「已经接过了」这一类（重复接取），幂等良性。
      return { ok: true, code, status, repeated: true, message: '已接取（此前已接过）' }
    }
    return { ok: true, code, status, message: `已接取（${status}）` }
  } catch (error) {
    const message = extractMessage(error) || (error instanceof Error ? error.message : String(error))
    if (/locked until/i.test(message)) {
      const when = /locked until\s*([0-9-]+)/i.exec(message)?.[1]
      return { ok: false, benign: true, code, message: when === undefined ? '未解锁' : `未解锁（${when} 开启）` }
    }
    if (isBenignMessage(message)) return { ok: false, benign: true, code, message: `跳过：${message}` }
    return { ok: false, code, message }
  }
}

/** 领取任务奖励。 */
export async function claimTask({ session, code, deviceToken, config = {}, signal }) {
  try {
    const response = await jsonRequest({
      url: `${baseUrl()}${GROWTH_CLAIM_PATH(code)}`,
      method: 'POST',
      headers: controlHeaders({ flavor: 'desktop', auth: session, deviceToken, config }),
      body: {},
      timeoutMs: Number(config.requestTimeoutMs ?? 30_000),
      signal,
      keepAlive: false,
    })
    const data = response.json?.data ?? {}
    if (data?.already_claimed === true) return { ok: false, benign: true, code, message: '已领取过' }
    const credit = Number(data?.credit ?? data?.credit_granted ?? 0) || 0
    const energy = Number(data?.energy ?? data?.energy_granted ?? 0) || 0
    const parts = [credit > 0 ? `+${credit} 积分` : '', energy > 0 ? `+${energy} 能量` : ''].filter(Boolean)
    return { ok: true, code, credit, energy, message: parts.length > 0 ? `领取成功 ${parts.join(' ')}` : '领取成功' }
  } catch (error) {
    const message = extractMessage(error) || (error instanceof Error ? error.message : String(error))
    if (isBenignMessage(message)) return { ok: false, benign: true, code, message: `跳过：${message}` }
    return { ok: false, code, message }
  }
}

/**
 * 跑一个账号的全部成长任务。
 *
 * @param {object} input
 * @param {object} input.session - 凭据
 * @param {string} [input.deviceToken]
 * @param {object} [input.config]
 * @param {AbortSignal} [input.signal]
 * @param {string[]} [input.skipTasks] - 用户指定不做的任务 code
 * @param {boolean} [input.dryRun] - 只报告不改状态
 * @returns {Promise<{ok: boolean, total: number, claimed: number, accepted: number, creditGot: number, skipped: object[], failed: object[], steps: object[], tasks: object[]}>}
 */
export async function runGrowthTasks({ session, deviceToken, config = {}, signal, skipTasks = [], dryRun = false }) {
  const skipSet = new Set((skipTasks ?? []).map(code => String(code).toLowerCase()))
  const listing = await fetchTasks({ session, deviceToken, config, signal })
  if (listing.ok !== true) {
    return { ok: false, message: listing.message, total: 0, claimed: 0, accepted: 0, creditGot: 0, skipped: [], failed: [], steps: [], tasks: [] }
  }

  const steps = []
  const skipped = []
  const failed = []
  let claimed = 0
  let accepted = 0
  let creditGot = 0

  for (const task of listing.tasks) {
    // ① 付费任务：一票否决，先于任何网络动作
    if (task.paid) {
      skipped.push({ code: task.code, title: task.title, reason: '需付费，已跳过' })
      steps.push({ code: task.code, step: 'skip_paid', status: 'skip' })
      continue
    }
    // ② 用户黑名单
    if (skipSet.has(task.code.toLowerCase())) {
      skipped.push({ code: task.code, title: task.title, reason: '在跳过名单里' })
      steps.push({ code: task.code, step: 'skip_user', status: 'skip' })
      continue
    }
    // ③ 已领取
    if (task.claimed) {
      steps.push({ code: task.code, step: 'already_claimed', status: 'skip' })
      continue
    }
    if (dryRun) {
      steps.push({ code: task.code, step: task.claimable ? 'would_claim' : 'would_accept', status: 'dry' })
      continue
    }

    // ④ 进度已达 → 直接领；未达 → 先接取（接取后才能推进）
    if (task.claimable) {
      const claim = await claimTask({ session, code: task.code, deviceToken, config, signal })
      if (claim.ok === true) {
        claimed += 1
        creditGot += claim.credit ?? 0
        steps.push({ code: task.code, step: 'claim', status: 'ok', message: claim.message })
      } else if (claim.benign === true) {
        steps.push({ code: task.code, step: 'claim', status: 'skip', message: claim.message })
      } else {
        failed.push({ code: task.code, title: task.title, step: 'claim', message: claim.message })
        steps.push({ code: task.code, step: 'claim', status: 'fail', message: claim.message })
      }
      continue
    }

    if (task.status !== 'accepted' && task.status !== 'in_progress') {
      const accept = await acceptTask({ session, code: task.code, deviceToken, config, signal })
      if (accept.ok === true) {
        accepted += 1
        steps.push({ code: task.code, step: 'accept', status: 'ok', message: accept.message })
      } else if (accept.benign === true) {
        steps.push({ code: task.code, step: 'accept', status: 'skip', message: accept.message })
      } else {
        failed.push({ code: task.code, title: task.title, step: 'accept', message: accept.message })
        steps.push({ code: task.code, step: 'accept', status: 'fail', message: accept.message })
      }
      continue
    }

    // 已接取但进度没到：程序不伪造进度，如实说「需先在客户端完成」
    steps.push({ code: task.code, step: 'wait_progress', status: 'skip', message: `${task.current}/${task.target} 需先在客户端完成` })
    skipped.push({ code: task.code, title: task.title, reason: `进度 ${task.current}/${task.target}，需在客户端完成` })
  }

  return {
    ok: failed.length === 0,
    total: listing.tasks.length,
    claimed,
    accepted,
    creditGot,
    skipped,
    failed,
    steps,
    tasks: listing.tasks,
  }
}
