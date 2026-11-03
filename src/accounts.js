/**
 * 多账号池。
 *
 * 状态文件 `~/.dsh-workbuddy/accounts.json`（0600 尽力而为），一条记录一个账号：
 *
 * ```jsonc
 * {
 *   "version": 2,
 *   "settings": { "autoCheckin": true, "checkinHours": [9,21], "autoActivity": true, "activityHours": [10] },
 *   "accounts": [{
 *     "id": "uid 或随机", "uid": "...", "nickname": "...", "enterpriseId": "...", "domain": "...",
 *     "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 0 },
 *     "active": true, "enabled": true, "addedAt": 0,
 *     "credits": 1234, "creditsAt": 0, "streakDays": 5, "streakAt": 0,
 *     "daily": { "checkin": "2026-10-21", "activity": "2026-10-21" },
 *     "lastCheckin": { "at": 0, "ok": true, "credit": 100, "message": "..." }
 *   }]
 * }
 * ```
 *
 * 这个模块只负责「谁能用、现在轮到谁、上次跑到哪天」，不碰网络：
 * 登录在 session 层，签到/余额在 growth 层。
 *
 * @module src/accounts.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 默认每日任务设置。 */
export const DEFAULT_DAILY_SETTINGS = Object.freeze({
  autoCheckin: true,
  checkinHours: Object.freeze([9, 21]),
  autoActivity: true,
  activityHours: Object.freeze([10]),
  autoGrowth: true,
  /**
   * 功能 1（按模型预算切号）：开启后，单账号在**单个模型**上当日消耗达到
   * `modelBudget` 就轮换到别的账号；轮换目标还必须余额 ≥ `switchFloor`
   * 且在该模型上没花超。关闭则任意轮切（只受 creditFloor 底线约束）。
   * 这三项 UI 可改、落盘持久。
   */
  modelBudgetEnabled: true,
  modelBudget: 200,
  switchFloor: 0,
})

/** 北京自然日（预算的重置边界，与签到回血同一天花板）。本地算，避免与 schedule.js 成环。 */
const CST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
export function cstDay(now = Date.now()) {
  return CST_DAY.format(new Date(now))
}

export class AccountsStore {
  /**
   * @param {object} input
   * @param {string} input.file
   * @param {{debug?: Function, warn?: Function, info?: Function}} [input.logger]
   * @param {object} [input.settings] - 每日任务的初始设置（来自插件 config）
   * @param {number} [input.creditFloor] - 模型车道的积分下限：已知余额低于它的账号**不参与
   *   聊天调用**（自动切到够的账号；全都不够就停用报错）。`0` = 关闭。
   *   只闸模型车道：每日签到 / 余额刷新照常跑——那正是低积分账号回血的途径。
   * 预算/切换下限三参数走 `settings`（见 DEFAULT_DAILY_SETTINGS），UI 可改，不再挤构造函数。
   */
  constructor({ file, logger, settings = {}, creditFloor = 0 }) {
    this.file = file
    this.logger = logger ?? {}
    this.settings = { ...DEFAULT_DAILY_SETTINGS, ...settings }
    const floor = Number(creditFloor)
    this.creditFloor = Number.isFinite(floor) && floor > 0 ? floor : 0
    /** @type {Array<object>} */
    this.accounts = []
    this.load()
  }

  // ── 功能 1：按模型的消耗预算与轮换下限（全部读 settings，UI 可改、落盘）──────
  get modelBudgetEnabled() {
    return this.settings.modelBudgetEnabled !== false
  }

  get modelBudget() {
    const budget = Number(this.settings.modelBudget)
    return Number.isFinite(budget) && budget > 0 ? budget : 0
  }

  /**
   * 轮换下限：余额**已知**低于此值的账号永远不会被当轮换目标；`0` = 不限制
   * （未测过余额的账号此时可以当目标）。当前账号的连任不受此限——它限制的是「切过去」。
   * creditFloor 是另一条独立底线（已知余额低于它的账号根本不参与），两者叠加生效。
   */
  get switchFloor() {
    const wanted = Number(this.settings.switchFloor)
    return Number.isFinite(wanted) && wanted > 0 ? wanted : 0
  }

  /** 该账号**已知**余额是否够当轮换目标（未测过 → 不算够）。 */
  meetsSwitchFloor(account) {
    const floor = this.switchFloor
    if (floor === 0) return true
    const credits = Number(account?.credits)
    return Number.isFinite(credits) && credits >= floor
  }

  /** 该账号今日（北京日）在该模型上的累计消耗。 */
  modelSpend(account, model) {
    if (account?.modelUsage?.date !== cstDay()) return 0
    return Number(account.modelUsage?.[model]) || 0
  }

  /** 该账号今日在该模型上是否已花到预算（预算关 / 未设 = 永远不超）。 */
  overModelBudget(account, model) {
    return this.modelBudgetEnabled && this.modelBudget > 0 && this.modelSpend(account, model) >= this.modelBudget
  }

  /**
   * 模型车道可用的账号：启用、且（下限开启时）已知余额不低于 creditFloor。
   *
   * 只闸余额、不看模型预算——积分任务与「余额刷新」走 `enabled()`；
   * 模型车道的完整资格在 `rotationCandidates`。
   *
   * @param {string} [route]
   */
  usable(route) {
    return this.enabled(route).filter(account => !this.belowFloor(account))
  }

  /** 该账号的**已知**余额是否低于下限。未测过（undefined）不算不足。 */
  belowFloor(account) {
    if (this.creditFloor === 0) return false
    const credits = Number(account?.credits)
    return Number.isFinite(credits) && credits < this.creditFloor
  }

  load() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (parsed?.settings !== undefined) this.settings = { ...this.settings, ...parsed.settings }
    const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.auth?.accessToken !== 'string' && typeof row.auth?.refreshToken !== 'string') continue
      this.accounts.push(normalizeAccount(row))
    }
    // 至少有一个处于「当前」：没有就取第一个启用的。
    if (!this.accounts.some(account => account.active === true)) {
      const first = this.accounts.find(account => account.enabled !== false)
      if (first !== undefined) first.active = true
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 2, at: Date.now(), settings: this.settings, accounts: this.accounts }, undefined, 2))
      try {
        fs.chmodSync(temp, 0o600)
      } catch {
        /* Windows 无 0600 语义 */
      }
      fs.renameSync(temp, this.file)
    } catch (error) {
      this.logger.warn?.(`workbuddy: 账号池落盘失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  /** 全部账号（含凭据，仅宿主内部使用）。 */
  all() {
    return this.accounts
  }

  enabled(route) {
    return this.accounts.filter(account => account.enabled !== false && (route === undefined || account.route === route))
  }

  byId(id) {
    return this.accounts.find(account => account.id === id)
  }

  /**
   * 当前账号。
   *
   * ⚠️ **必须按路由过滤**：账号是平台相关的资产（国内账号的凭据在海外域毫无意义），
   * 一个池子里混着两个平台的账号时，海外路由绝不能拿到国内账号的 token 去发请求——
   * 那会得到 401 + 一次无意义的 refresh，然后被误判成「账号坏了」。
   *
   * @param {string} [route]
   */
  active(route) {
    const pool = this.accounts.filter(account => account.enabled !== false && (route === undefined || account.route === route))
    return pool.find(account => account.active === true) ?? pool[0]
  }

  /**
   * 把一次登录结果并入池子。
   *
   * 同一个 uid 再次登录视为**覆盖凭据**（重新登录同一个账号是修 session 的常规操作），
   * 而不是多出一条重复记录。
   */
  add({ auth, account, route = 'codebuddy' }) {
    const uid = stringOf(account?.uid)
    const existing = uid === undefined ? undefined : this.accounts.find(row => row.uid === uid && row.route === route)
    const now = Date.now()
    if (existing !== undefined) {
      existing.auth = { ...existing.auth, ...auth }
      existing.nickname = stringOf(account?.nickname) ?? existing.nickname
      existing.enterpriseId = stringOf(account?.enterpriseId) ?? existing.enterpriseId
      existing.domain = stringOf(auth?.domain) ?? existing.domain
      existing.enabled = true
      existing.lastLoginAt = now
      this.save()
      return { account: existing, created: false }
    }
    const row = normalizeAccount({
      id: uid ?? `acc_${crypto.randomBytes(6).toString('hex')}`,
      uid,
      route,
      nickname: stringOf(account?.nickname),
      enterpriseId: stringOf(account?.enterpriseId),
      domain: stringOf(auth?.domain),
      auth,
      // 当前账号是**按路由**唯一的：这个路由下还没有别的账号时，它就是当前。
      active: this.enabled(route).length === 0,
      enabled: true,
      addedAt: now,
      lastLoginAt: now,
    })
    this.accounts.push(row)
    // 同一路由内只保留一个「当前」——必须在 push **之后**跑，否则这个循环会把
    // 旧当前置 false、而新账号还没进列表，整池子没人 active（实测踩过这个坑）。
    if (row.active === true) {
      for (const other of this.accounts) if (other.route === route) other.active = other.id === row.id
    }
    this.save()
    return { account: row, created: true }
  }

  remove(id) {
    const index = this.accounts.findIndex(account => account.id === id)
    if (index === -1) return false
    const [removed] = this.accounts.splice(index, 1)
    if (removed.active === true) {
      const next = this.accounts.find(account => account.enabled !== false)
      if (next !== undefined) next.active = true
    }
    this.save()
    return true
  }

  /** 切换当前账号（同路由内切换）。 */
  activate(id) {
    const target = this.byId(id)
    if (target === undefined) return false
    for (const account of this.accounts) {
      if (account.route === target.route) account.active = account.id === id
    }
    if (target.enabled === false) target.enabled = true
    this.save()
    return true
  }

  /** 轮换到同路由的下一个可用账号（故障转移用）。返回新当前账号。
   *
   * 候选池 = `rotationCandidates`（功能 1 的完整资格：creditFloor、该模型当日预算、
   * switchFloor）。一个候选都没有时退回「启用池」——单账号池的凭据转移总得有个落点。
   */
  rotate(from, model) {
    if (from === undefined) return undefined
    const candidates = this.rotationCandidates(from.route, model)
    const pool = candidates.length > 0 ? candidates : this.enabled(from.route)
    if (pool.length <= 1) return undefined
    const index = pool.findIndex(account => account.id === from.id)
    const next = pool[(index + 1 + pool.length) % pool.length]
    if (next === undefined || next.id === from.id) return undefined
    this.activate(next.id)
    return next
  }

  update(id, patch) {
    const account = this.byId(id)
    if (account === undefined) return undefined
    Object.assign(account, patch)
    this.save()
    return account
  }

  /** 记录「今天这个任务已经跑过了」（按 CST 自然日）。 */
  markDaily(id, kind, date) {
    const account = this.byId(id)
    if (account === undefined) return
    account.daily = { ...(account.daily ?? {}), [kind]: date }
    this.save()
  }

  /**
   * 模型车道可用（可作当前 / 轮换目标）的账号：启用、不撞 creditFloor；
   * 预算开启时还要求**该模型上没花超**。
   */
  usableForModel(route, model) {
    return this.enabled(route).filter(account => !this.belowFloor(account)
      && !(model !== undefined && this.overModelBudget(account, model)))
  }

  /**
   * 轮换目标池（功能 1 的语义核心）：
   * - 关闭预算：任意轮切，只有 creditFloor 底线（用户原话「账号任意切换，但不能低于100」）。
   * - 开启预算：还要在该模型上没花超，且**余额已知且 ≥ switchFloor**——
   *   未测过余额的账号不当目标（无法证明它够），余额低于下限的账号永不切过去。
   */
  rotationCandidates(route, model) {
    const base = this.enabled(route).filter(account => !this.belowFloor(account))
    if (!this.modelBudgetEnabled) return base
    const underBudget = model === undefined ? base : base.filter(account => !this.overModelBudget(account, model))
    return underBudget.filter(account => this.meetsSwitchFloor(account))
  }

  /**
   * 模型车道取当前账号。
   *
   * 语义分两层（用户明确要求的）：
   * - **当前账号的连任**只看 creditFloor + 该模型当日预算——它只要还能干活就继续用，
   *   哪怕余额低于 switchFloor（「不能作为切换的」限制的是切*过去*，不是留在原地）；
   * - **必须换人时**按 `rotationCandidates` 挑，候选按「今日在该模型花得最少」排序
   *   （把消耗摊匀，而不是逮着一个薅），并列时优先当前、再按加入顺序。
   *
   * @param {string} [route]
   * @param {string} [model] - 功能 1 用：账号在该模型上的当日预算判定
   * @returns {{account?: object, allDrained: boolean, drained: object[], budgetExhausted?: boolean}}
   */
  pickForModel(route, model) {
    const pool = this.enabled(route)
    if (pool.length === 0) return { allDrained: false, drained: [] }
    const current = pool.find(account => account.active === true) ?? pool[0]
    const currentOk = current !== undefined
      && !this.belowFloor(current)
      && !(this.modelBudgetEnabled && model !== undefined && this.overModelBudget(current, model))
    if (currentOk) return { account: current, allDrained: false, drained: [] }

    const candidates = this.rotationCandidates(route, model)
    const drained = pool.filter(account => !candidates.includes(account))
    if (candidates.length === 0) {
      return {
        allDrained: pool.every(account => this.belowFloor(account)),
        budgetExhausted: pool.length > 0
          && model !== undefined
          && this.modelBudgetEnabled
          && pool.every(account => !this.belowFloor(account) && (this.overModelBudget(account, model) || !this.meetsSwitchFloor(account)))
          && pool.some(account => this.overModelBudget(account, model)),
        drained,
      }
    }
    const spendOf = account => model === undefined || !this.modelBudgetEnabled ? 0 : this.modelSpend(account, model)
    const next = [...candidates].sort((a, b) => (spendOf(a) - spendOf(b))
      || ((b.active === true ? 1 : 0) - (a.active === true ? 1 : 0)))[0]
    if (next.active !== true) {
      const reason = current !== undefined && model !== undefined && this.overModelBudget(current, model)
        ? `模型 ${model} 今日预算（${this.modelBudget}）已用完`
        : current !== undefined && this.belowFloor(current)
          ? `余额低于 ${this.creditFloor}`
          : '不满足轮换条件'
      for (const account of this.accounts) if (account.route === next.route) account.active = account.id === next.id
      this.save()
      this.logger.info?.(`workbuddy: 当前账号${reason}，模型车道已切到 ${next.nickname ?? next.uid ?? next.id}`)
    }
    return { account: next, allDrained: false, drained }
  }

  /**
   * 记一次真实调用的积分消耗。
   *
   * 上游在流的最后一帧里给 `usage.credit`（实测：免费模型就是 0），所以这里是**实测值**
   * 而不是估算。保留最近 30 条，供设置页显示「这个模型刚才花了多少」。
   *
   * @param {string} id
   * @param {{model?: string, credit?: number, inputTokens?: number, outputTokens?: number, at?: number}} entry
   */
  recordUsage(id, entry) {
    const account = this.byId(id)
    if (account === undefined) return
    const row = {
      at: Number(entry?.at) || Date.now(),
      model: entry?.model ?? undefined,
      credit: Number.isFinite(Number(entry?.credit)) ? Number(entry.credit) : undefined,
      inputTokens: Number.isFinite(Number(entry?.inputTokens)) ? Number(entry.inputTokens) : undefined,
      outputTokens: Number.isFinite(Number(entry?.outputTokens)) ? Number(entry.outputTokens) : undefined,
    }
    account.lastUsage = row
    const log = Array.isArray(account.creditLog) ? account.creditLog : []
    log.push(row)
    account.creditLog = log.slice(-30)
    if (row.credit !== undefined && account.credits !== undefined) account.credits = Math.max(0, Number(account.credits) - row.credit)
    // 功能 1 的账本：按「北京自然日 + 模型」累计实测消耗（预算判定读它，跨天自动清零）。
    if (Number.isFinite(row.credit) && row.credit > 0 && typeof row.model === 'string' && row.model !== '') {
      const today = cstDay()
      const budget = account.modelUsage !== null && typeof account.modelUsage === 'object' && account.modelUsage.date === today
        ? account.modelUsage
        : { date: today }
      budget[row.model] = (Number(budget[row.model]) || 0) + row.credit
      account.modelUsage = budget
    }
    this.save()
  }

  /** 更新每日任务设置（来自 UI 的开关与时刻）。 */
  updateSettings(patch) {
    const next = { ...this.settings }
    if (typeof patch.autoCheckin === 'boolean') next.autoCheckin = patch.autoCheckin
    if (typeof patch.autoActivity === 'boolean') next.autoActivity = patch.autoActivity
    if (typeof patch.autoGrowth === 'boolean') next.autoGrowth = patch.autoGrowth
    if (Array.isArray(patch.checkinHours)) next.checkinHours = normalizeHours(patch.checkinHours, DEFAULT_DAILY_SETTINGS.checkinHours)
    if (Array.isArray(patch.activityHours)) next.activityHours = normalizeHours(patch.activityHours, DEFAULT_DAILY_SETTINGS.activityHours)
    // 功能 1：按模型预算切号（UI 可改，落盘持久）。
    if (typeof patch.modelBudgetEnabled === 'boolean') next.modelBudgetEnabled = patch.modelBudgetEnabled
    if (patch.modelBudget !== undefined) {
      const budget = Number(patch.modelBudget)
      if (Number.isFinite(budget) && budget > 0) next.modelBudget = Math.max(1, Math.round(budget))
    }
    if (patch.switchFloor !== undefined) {
      const floor = Number(patch.switchFloor)
      if (Number.isFinite(floor) && floor >= 0) next.switchFloor = Math.max(0, Math.round(floor))
    }
    this.settings = next
    this.save()
    return next
  }

  /**
   * 导出账号 JSON（设置页的「导出 JSON」按钮）。
   *
   * 形状与导入一致（`{ accounts: [{ route, uid, nickname, auth }] }`）：导出的文件
   * 可以直接粘回「导入 JSON」，也能拷给别家网关或做备份。默认**带凭据**——这个
   * 接口只在回环受理，导出的本来就是完整可迁移的账号数据；`withTokens: false`
   * 时 auth 只留一个存在性标记。
   *
   * @param {{withTokens?: boolean}} [options]
   */
  exportJson({ withTokens = true } = {}) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: this.accounts.map(account => ({
        route: account.route ?? 'codebuddy',
        uid: account.uid,
        nickname: account.nickname,
        enterpriseId: account.enterpriseId,
        domain: account.domain ?? account.auth?.domain,
        auth: withTokens === true
          ? {
              accessToken: account.auth?.accessToken,
              refreshToken: account.auth?.refreshToken,
              expiresAt: account.auth?.expiresAt,
            }
          : { present: account.auth?.accessToken !== undefined && account.auth.accessToken !== '' },
      })),
    }
  }

  /**
   * 给浏览器/模型看的视图：**绝不包含任何 token 字段**。
   */
  view() {
    const view = account => ({
      id: account.id,
      route: account.route ?? 'codebuddy',
      uid: account.uid ?? null,
      nickname: account.nickname ?? null,
      active: account.active === true,
      enabled: account.enabled !== false,
      creditLow: this.belowFloor(account),
      expiresAt: account.auth?.expiresAt ?? null,
      hasRefreshToken: typeof account.auth?.refreshToken === 'string' && account.auth.refreshToken !== '',
      credits: account.credits,
      creditsAt: account.creditsAt,
      creditPackages: Array.isArray(account.creditPackages) ? account.creditPackages.slice(0, 5) : undefined,
      streakDays: account.streakDays,
      daily: account.daily ?? {},
      lastCheckin: account.lastCheckin,
      lastActivity: account.lastActivity,
      lastUsage: account.lastUsage,
      creditLog: Array.isArray(account.creditLog) ? account.creditLog.slice(-10) : [],
      // 功能 1：今日（北京日）各模型已花积分。预算开着时 UI 才能显示「glm-5.3：80/200」。
      todayModelSpend: account.modelUsage?.date === cstDay()
        ? Object.fromEntries(Object.entries(account.modelUsage).filter(([key, value]) => key !== 'date' && Number.isFinite(Number(value))))
        : undefined,
    })
    // 刻意不返回 null 字段：浏览器侧只要按「有/没有」判断就绝不会踩到 null.ok 这类崩溃。
    return {
      settings: this.settings,
      creditFloor: this.creditFloor > 0 ? this.creditFloor : undefined,
      // 功能 1 的生效值（两条底线独立：creditFloor 管参与，switchFloor 管「被切过去」）。
      budget: {
        enabled: this.modelBudgetEnabled,
        modelBudget: this.modelBudget,
        switchFloor: this.switchFloor,
      },
      totals: this.totals(),
      accounts: this.accounts.map(account => stripEmpty(view(account))),
    }
  }

  /**
   * 按平台汇总总积分：`{ codebuddy: {accounts, known, credits, at}, workbuddy: … }`。
   *
   * 只累加**已知**余额（刷新过余额或调用扣过数的账号）；`known < accounts`
   * 说明还有账号没测过余额，合计只是部分值——页面上必须把这一点显示出来，
   * 不能让「没刷新过的账号」被算成 0 分后冒充总额。
   */
  totals() {
    const out = {}
    for (const account of this.accounts) {
      const route = account.route ?? 'codebuddy'
      const bucket = out[route] ??= { accounts: 0, known: 0, credits: 0, at: undefined }
      bucket.accounts += 1
      const credits = Number(account.credits)
      if (Number.isFinite(credits)) {
        bucket.credits += credits
        bucket.known += 1
        const at = Number(account.creditsAt)
        if (Number.isFinite(at) && (bucket.at === undefined || at > bucket.at)) bucket.at = at
      }
    }
    return out
  }
}

/** 去掉值为 undefined / null 的键（保留 false / 0 / 空字符串）。 */
function stripEmpty(record) {
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue
    out[key] = value
  }
  return out
}

function stringOf(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/** 小时数组归一：去重、取整、夹到 0–23。 */
export function normalizeHours(input, fallback) {
  const hours = (Array.isArray(input) ? input : [])
    .map(value => Math.trunc(Number(value)))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 23)
  const unique = [...new Set(hours)].sort((a, b) => a - b)
  return unique.length > 0 ? unique : [...fallback]
}

function normalizeAccount(row) {
  return {
    id: stringOf(row.id) ?? `acc_${crypto.randomBytes(6).toString('hex')}`,
    uid: stringOf(row.uid),
    route: stringOf(row.route) ?? 'codebuddy',
    nickname: stringOf(row.nickname),
    enterpriseId: stringOf(row.enterpriseId),
    domain: stringOf(row.domain ?? row.auth?.domain),
    auth: {
      accessToken: stringOf(row.auth?.accessToken),
      refreshToken: stringOf(row.auth?.refreshToken),
      expiresAt: Number(row.auth?.expiresAt) || undefined,
      domain: stringOf(row.auth?.domain ?? row.domain),
    },
    active: row.active === true,
    enabled: row.enabled !== false,
    addedAt: Number(row.addedAt) || Date.now(),
    lastLoginAt: Number(row.lastLoginAt) || undefined,
    credits: Number.isFinite(Number(row.credits)) ? Number(row.credits) : undefined,
    creditsAt: Number(row.creditsAt) || undefined,
    creditPackages: Array.isArray(row.creditPackages) ? row.creditPackages.slice(0, 5) : undefined,
    streakDays: Number.isFinite(Number(row.streakDays)) ? Number(row.streakDays) : undefined,
    streakAt: Number(row.streakAt) || undefined,
    daily: row.daily !== null && typeof row.daily === 'object' ? { ...row.daily } : {},
    lastCheckin: row.lastCheckin ?? undefined,
    lastActivity: row.lastActivity ?? undefined,
    lastUsage: row.lastUsage ?? undefined,
    creditLog: Array.isArray(row.creditLog) ? row.creditLog.slice(-30) : [],
    // 功能 1 的账本：{ date: 'YYYY-MM-DD'(北京), [model]: 当日累计消耗 }
    modelUsage: row.modelUsage !== null && typeof row.modelUsage === 'object' && !Array.isArray(row.modelUsage)
      ? { ...row.modelUsage }
      : undefined,
    lastError: row.lastError ?? undefined,
  }
}