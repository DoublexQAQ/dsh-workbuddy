/**
 * 每日排程。
 *
 * 语义刻意做得保守，因为这个东西是「无人值守跑在你账号上的」：
 *
 * - **按 CST 自然日**（Asia/Shanghai）判定「今天跑过没有」，与机器时区无关；
 * - 每个任务在**配置的整点**触发，并在启动/唤醒时做一次**追赶**（catch-up）：
 *   今天已经过了配置时刻但还没跑过，就补一次——笔记本不是 7×24 开机的，
 *   只按整点触发等于天天漏；
 * - 先**标记再执行**：标记落盘在任务执行之前，所以崩溃/重启不会导致重复触发
 *   （重复本身也是幂等的：上游对同一天重复签到回 `code 10001`）。
 *
 * @module src/schedule.js
 */

export const CST_TIME_ZONE = 'Asia/Shanghai'

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: CST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: CST_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * 现在（北京时区）是哪一天、几点。
 *
 * @param {number} [at]
 * @returns {{date: string, hour: number, minute: number}}
 */
export function cstParts(at = Date.now()) {
  const now = new Date(at)
  const date = DATE_FORMAT.format(now)
  const time = TIME_FORMAT.format(now)
  const [hour, minute] = time.split(':').map(value => Number.parseInt(value, 10))
  return { date, hour: Number.isFinite(hour) ? hour : 0, minute: Number.isFinite(minute) ? minute : 0 }
}

/** 一个任务当天最晚的配置时刻（用于追赶判定）。 */
export function latestHour(hours) {
  const list = Array.isArray(hours) && hours.length > 0 ? hours : []
  return list.length === 0 ? undefined : Math.max(...list)
}

/**
 * 按设置算出「现在应该跑哪些任务」。
 *
 * @param {object} settings - `{autoCheckin, checkinHours, autoActivity, activityHours}`
 * @param {number} [at]
 * @returns {{date: string, hour: number, tasks: string[], catchUp: string[]}}
 */
export function dueTasks(settings, at = Date.now()) {
  const { date, hour } = cstParts(at)
  const tasks = []
  const catchUp = []
  const checkinHours = Array.isArray(settings?.checkinHours) ? settings.checkinHours : [9, 21]
  const activityHours = Array.isArray(settings?.activityHours) ? settings.activityHours : [10]

  if (settings?.autoCheckin !== false) {
    if (checkinHours.includes(hour)) tasks.push('checkin')
    const last = latestHour(checkinHours)
    if (last !== undefined && hour > last) catchUp.push('checkin')
  }
  if (settings?.autoActivity !== false) {
    if (activityHours.includes(hour)) tasks.push('activity')
    const last = latestHour(activityHours)
    if (last !== undefined && hour > last) catchUp.push('activity')
  }
  return { date, hour, tasks, catchUp }
}

export class DailyScheduler {
  /**
   * @param {object} input
   * @param {import('./accounts.js').AccountsStore} input.accounts
   * @param {{info?: Function, warn?: Function, debug?: Function}} [input.logger]
   * @param {(account: object, kind: string, date: string) => Promise<void>} input.run
   * @param {number} [input.intervalMs] - 检查周期（默认 60 秒）
   */
  constructor({ accounts, logger, run, intervalMs = 60_000 }) {
    this.accounts = accounts
    this.logger = logger ?? {}
    this.run = run
    this.intervalMs = intervalMs
    this.running = false
  }

  /**
   * 一次检查：触发到点的任务，并对每个启用的账号做追赶。
   *
   * @param {number} [at]
   * @param {{catchUp?: boolean}} [options]
   */
  async tick(at = Date.now(), options = {}) {
    if (this.running) return { skipped: 'busy' }
    this.running = true
    const executed = []
    try {
      const settings = this.accounts.settings
      const { date, tasks, catchUp } = dueTasks(settings, at)
      const plan = new Set(tasks)
      if (options.catchUp === true) for (const kind of catchUp) plan.add(kind)
      for (const account of this.accounts.enabled()) {
        for (const kind of plan) {
          if (account.daily?.[kind] === date) continue
          // 先落盘「今天跑过」，再执行：崩溃/重启不会变成重复触发。
          this.accounts.markDaily(account.id, kind, date)
          executed.push({ id: account.id, kind, date })
          try {
            await this.run(account, kind, date)
          } catch (error) {
            this.logger.warn?.(`workbuddy: ${kind} 失败（${account.nickname ?? account.uid ?? account.id}）：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return { date, executed }
    } finally {
      this.running = false
    }
  }

  /**
   * 挂到宿主生命周期上：先立即追赶一次，然后每分钟检查。
   *
   * @param {{effect: Function}} ctx
   */
  start(ctx) {
    ctx.effect(() => {
      let disposed = false
      const handle = setInterval(() => {
        if (!disposed) void this.tick(new Date().getTime(), { catchUp: true })
      }, this.intervalMs)
      handle.unref?.()
      void this.tick(Date.now(), { catchUp: true })
      return () => {
        disposed = true
        clearInterval(handle)
      }
    }, 'dsh-workbuddy: daily schedule')
  }
}

/**
 * 手动跑一个账号的一项任务（UI 的「立即签到」按钮走这条），返回可展示的结果。
 *
 * @param {object} input
 * @param {import('./accounts.js').AccountsStore} input.accounts
 * @param {(account: object) => Promise<object>} input.sessionFor - 取（并刷新到新鲜的）凭据
 * @param {(input: object) => Promise<object>} input.runGrowth
 * @param {object} input.logger
 */
export async function runNow({ accounts, account, sessionFor, runGrowth, deviceToken, config, logger }) {
  const credentials = await sessionFor(account)
  const result = await runGrowth({ session: credentials, deviceToken, config })
  const { date } = cstParts()
  accounts.update(account.id, {
    daily: { ...(account.daily ?? {}), checkin: date },
    ...(result.checkin === undefined
      ? {}
      : {
          lastCheckin: {
            at: result.at,
            ok: result.checkin.ok === true,
            already: result.checkin.already === true,
            credit: result.checkin.credit,
            message: result.checkin.message,
          },
        }),
    ...(result.activity === undefined ? {} : { lastActivity: { at: result.at, ok: result.activity.ok === true, message: result.activity.message } }),
    ...(result.credits === undefined ? {} : { credits: result.credits, creditsAt: result.at }),
    ...(result.streakDays === undefined ? {} : { streakDays: result.streakDays, streakAt: result.at }),
  })
  logger?.debug?.(`workbuddy: 手动积分任务完成（${account.nickname ?? account.uid ?? account.id}）`)
  return result
}