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
   * 模型轮换链：用户自己挑 3–4 个模型，数组顺序 = 优先级。
   * 第一个被上游禁用（模型下线 / 账号无权限 / 限流）就自动轮到后面的；
   * 整条链在该账号上全被禁用，就自动轮换到下一个账号（再按链从第一个试）。
   * 链为空 = 关闭这套轮换，直接用请求里的模型。
   */
  modelChain: Object.freeze([]),
  modelChainEnabled: true,
  /**
   * 旧版「按模型预算切号」参数：保留仅为了读老配置文件不炸，
   * 已不参与切号决策（轮换改由 modelChain 负责）。
   */
  modelBudgetEnabled: false,
  modelBudget: 0,
  switchFloor: 0,
  /**
   * 自动兑换：刷新成长/发现「可兑」档位时当场全部兑掉，不等于下一次签到闭环。
   * 设置页可关；关掉后只报告「可兑 X 档」，兑换仍走签到闭环或手动。
   */
  autoRedeem: true,
  /**
   * 积分闸门阈值：用户自己填的数，已知余额低于它的账号自动跳过并换号；
   * 全部低于就停止使用（签到回血后自动恢复）。`0` = 关闭闸门。
   */
  creditFloor: 100,
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
   * @param {number} [input.creditFloor] - 积分闸门的**初始**值；生效值在 settings.creditFloor
   *   （UI 可改、落盘持久）。已知余额低于它的账号自动换掉；全都低于就停用报错。`0` = 关闭。
   *   只闸模型车道：每日签到 / 余额刷新照常跑——那正是低积分账号回血的途径。
   */
  constructor({ file, logger, settings = {}, creditFloor }) {
    this.file = file
    this.logger = logger ?? {}
    this.settings = { ...DEFAULT_DAILY_SETTINGS, ...settings }
    // 种子优先级：settings.creditFloor（index.js 显式传入 / 文件里存的）> 构造参数 > 默认值。
        // 必须在合并 DEFAULTS 之前读原始 settings——否则默认的 100 永远压过构造参数，
        // new AccountsStore({ creditFloor: 0 }) 想关闸门会被默认值吃掉（实测踩过的坑）。
        const seed = Number(settings.creditFloor ?? creditFloor ?? DEFAULT_DAILY_SETTINGS.creditFloor)
    // 合法数字（含 0=关闸）直接采用，负数按 0 处理；NaN 才落默认值。
    this.settings.creditFloor = Number.isFinite(seed) ? Math.max(0, Math.round(seed)) : DEFAULT_DAILY_SETTINGS.creditFloor
    /** @type {Array<object>} */
    this.accounts = []
    this.load()
  }

  /**
   * 积分闸门阈值：用户自己填的数，已知余额低于它的账号不参与聊天调用。
   * 读 settings（UI 可改、落盘持久），`0` = 关闭闸门。
   */
  get creditFloor() {
    const floor = Number(this.settings.creditFloor)
    return Number.isFinite(floor) && floor > 0 ? floor : 0
  }

  set creditFloor(value) {
    const floor = Number(value)
    if (Number.isFinite(floor) && floor >= 0) this.settings.creditFloor = Math.round(floor)
  }

  // ── 模型轮换链（用户自选 3–4 个模型，按顺序 fallback）──────────────────────
  /** 用户选定的模型链，数组顺序 = 优先级。空数组 = 不启用链式轮换。 */
  get modelChain() {
    const list = Array.isArray(this.settings.modelChain) ? this.settings.modelChain : []
    return [...new Set(list.filter(id => typeof id === 'string' && id !== ''))].slice(0, 6)
  }

  get modelChainEnabled() {
    return this.settings.modelChainEnabled !== false && this.modelChain.length > 0
  }

  /**
   * 这个账号今天在该模型上是否已被判「禁用」。
   * 记录来源：上游明确拒绝（模型下线 / 无权限 / 限流冷却），写进 account.modelBlocked。
   */
  modelBlocked(account, model) {
    if (model === undefined || model === '') return false
    const map = account?.modelBlocked
    if (map === null || typeof map !== 'object' || map.date !== cstDay()) return false
    return map[model] !== undefined
  }

  /** 把一个模型在这个账号上标记禁用（当日有效，跨天自动失效）。 */
  blockModel(id, model, reason) {
    const account = this.byId(id)
    if (account === undefined || typeof model !== 'string' || model === '') return
    const today = cstDay()
    const map = account.modelBlocked !== null && typeof account.modelBlocked === 'object' && account.modelBlocked.date === today
      ? account.modelBlocked
      : { date: today }
    map[model] = { at: Date.now(), reason: String(reason ?? '') }
    account.modelBlocked = map
    this.save()
  }

  /** 清空某个账号当日的模型禁用表（用户手动解除）。 */
  clearModelBlocks(id) {
    const account = this.byId(id)
    if (account === undefined) return
    account.modelBlocked = undefined
    this.save()
  }

  /**
   * 给这个账号挑出**实际可用**的模型链：按用户顺序，跳过今日已被禁用的。
   * 链为空 / 功能关闭时，退化成 `[请求的模型]`（跳过禁用判定）。
   *
   * @param {object|undefined} account
   * @param {string} requested - 本轮请求的模型
   * @returns {{ model: string, chain: string[], skipped: string[], exhausted: boolean }}
   */
  chainForAccount(account, requested) {
    const chain = this.modelChainEnabled ? this.modelChain : []
    if (chain.length === 0) return { model: requested, chain: [requested], skipped: [], exhausted: false }
    const skipped = []
    for (const model of chain) {
      if (this.modelBlocked(account, model)) { skipped.push(model); continue }
      return { model, chain, skipped, exhausted: false }
    }
    // 整条链在这个号上都被禁用了
    return { model: undefined, chain, skipped, exhausted: true }
  }

  /** 候选账号：启用、未撞 creditFloor，且（开了链时）链上还有没被禁的模型。 */
  accountsWithChainLeft(route, requested) {
    return this.enabled(route)
      .filter(account => !this.belowFloor(account))
      .filter(account => this.chainForAccount(account, requested).exhausted !== true)
  }

  // ── 旧版预算接口：保评论/兼容，不参与决策 ─────────────────────────────────
  get modelBudgetEnabled() {
    return false
  }

  get modelBudget() {
    return 0
  }

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

  /** 该账号今日（北京日）在该模型上的累计消耗（仅用于展示，不参与切号）。 */
  modelSpend(account, model) {
    if (account?.modelUsage?.date !== cstDay()) return 0
    return Number(account.modelUsage?.[model]) || 0
  }

  /** 旧版预算判定：已停用，恒为 false。 */
  overModelBudget() {
    return false
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

  /** 切换当前账号（同路由内切换）。lastActiveAt 给胶囊用：跨路由各有 active 时，
   *  界面显示「最近激活」的那个，切完立刻跟手。 */
  activate(id) {
    const target = this.byId(id)
    if (target === undefined) return false
    for (const account of this.accounts) {
      if (account.route === target.route) account.active = account.id === id
    }
    if (target.enabled === false) target.enabled = true
    target.lastActiveAt = Date.now()
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
   * 模型车道可用（可作当前 / 轮换目标）的账号：启用、不撞 creditFloor、
   * 且（开了链时）链上还有没被禁的模型。
   */
  usableForModel(route, requested) {
    return this.enabled(route)
      .filter(account => !this.belowFloor(account))
      .filter(account => this.chainForAccount(account, requested).exhausted !== true)
  }

  /**
   * 轮换目标池：启用、不撞 creditFloor、（开了链时）链上还有没被禁的模型。
   */
  rotationCandidates(route, requested) {
    const base = this.enabled(route).filter(account => !this.belowFloor(account))
    if (this.modelChain.length === 0) return base
    return base.filter(account => this.chainForAccount(account, requested).exhausted !== true)
  }

  /**
   * 取本轮「账号 + 模型」组合。
   *
   * 规则：
   * 1. 用户选定的模型链按顺序试，第一个还能用的就是本轮的模型；
   * 2. 当前账号在这条链上全被禁用了 → 换账号，换到链上还有可用模型的号；
   * 3. 换过去的号从链的第一个模型重新开始试。
   *
   * @param {string} [route]
   * @param {string} [requested] - 本轮请求的模型（链为空时直接用它）
   * @returns {{
   *   account?: object, model?: string, chain: string[], skipped: string[],
   *   allDrained: boolean, drained: object[], chainExhausted?: boolean
   * }}
   */
  pickForModel(route, requested) {
    const pool = this.enabled(route)
    if (pool.length === 0) return { chain: [], skipped: [], allDrained: false, drained: [] }

    const current = pool.find(account => account.active === true) ?? pool[0]

    if (current !== undefined && !this.belowFloor(current)) {
      const pick = this.chainForAccount(current, requested)
      if (pick.exhausted !== true) {
        return { account: current, model: pick.model, chain: pick.chain, skipped: pick.skipped, allDrained: false, drained: [] }
      }
    }

    const candidates = this.rotationCandidates(route, requested)
    const drained = pool.filter(account => !candidates.includes(account))
    if (candidates.length === 0) {
      const everyoneLow = pool.every(account => this.belowFloor(account))
      return {
        chain: this.modelChain.length > 0 ? this.modelChain : (requested === undefined ? [] : [requested]),
        skipped: current === undefined ? [] : this.chainForAccount(current, requested).skipped,
        allDrained: everyoneLow,
        chainExhausted: everyoneLow !== true && this.modelChain.length > 0,
        drained,
      }
    }

    const next = candidates[0]
    const pick = this.chainForAccount(next, requested)
    if (next.active !== true) {
      for (const account of this.accounts) if (account.route === next.route) account.active = account.id === next.id
      this.save()
      const reason = current === undefined
        ? '没有当前账号'
        : this.belowFloor(current)
          ? `余额低于 ${this.creditFloor}`
          : `模型链 [${this.modelChain.join(' → ')}] 在该账号上全部被禁用`
      this.logger.info?.(`workbuddy: ${reason}，已切到 ${next.nickname ?? next.uid ?? next.id}，本轮用 ${pick.model}`)
    }
    return { account: next, model: pick.model, chain: pick.chain, skipped: pick.skipped, allDrained: false, drained }
  }

  /**
   * 上游拒绝时换到下一个账号（换号后从链的第一个模型重来）。
   *
   * 只认 creditFloor：这条是「当前号被拒了，得马上换一个」，
   * 卡别的条件会让一轮调用直接失败，而失败本身并不说明余额不够。
   *
   * @param {string} route
   * @param {Iterable<string>} [exclude] - 本轮已经试过的账号 id
   * @param {string} [requested] - 换号后按这条链重新挑模型
   * @returns {object|undefined} 新的当前账号
   */
  failover(route, exclude, requested) {
    const skip = new Set(exclude ?? [])
    const pool = this.enabled(route)
    if (pool.length === 0) return undefined
    const current = pool.find(account => account.active === true)
    const candidates = pool
      .filter(account => !skip.has(account.id) && !this.belowFloor(account))
      .filter(account => this.chainForAccount(account, requested).exhausted !== true)
    if (candidates.length === 0) return undefined
    const next = candidates[0]
    if (next.id === current?.id) return next
    for (const account of this.accounts) if (account.route === next.route) account.active = account.id === next.id
    this.save()
    this.logger.warn?.(`workbuddy: 上游拒绝了 ${current?.nickname ?? current?.uid ?? current?.id ?? '当前账号'}，已换到 ${next.nickname ?? next.uid ?? next.id}`)
    return next
  }


  /**
   * 记一次上游拒绝：只写诊断字段，不动余额（余额归零是 `recordUsage`/积分闸门的事）。
   *
   * @param {string} id
   * @param {{message?: string, code?: string, status?: number}} failure
   */
  noteFailure(id, failure) {
    const account = this.byId(id)
    if (account === undefined) return
    account.lastError = {
      at: Date.now(),
      message: String(failure?.message ?? 'upstream rejected'),
      code: failure?.code,
      status: failure?.status,
    }
    this.save()
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

  /** 更新设置（来自 UI 的开关、时刻、模型链）。 */
  updateSettings(patch) {
    const next = { ...this.settings }
    if (typeof patch.autoCheckin === 'boolean') next.autoCheckin = patch.autoCheckin
    if (typeof patch.autoActivity === 'boolean') next.autoActivity = patch.autoActivity
    if (typeof patch.autoGrowth === 'boolean') next.autoGrowth = patch.autoGrowth
    if (Array.isArray(patch.checkinHours)) next.checkinHours = normalizeHours(patch.checkinHours, DEFAULT_DAILY_SETTINGS.checkinHours)
    if (Array.isArray(patch.activityHours)) next.activityHours = normalizeHours(patch.activityHours, DEFAULT_DAILY_SETTINGS.activityHours)
    // 模型轮换链：用户自选 3–4 个，数组顺序即优先级；去重、去空、上限 6。
    if (Array.isArray(patch.modelChain)) {
      const list = patch.modelChain
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(value => value !== '')
      next.modelChain = [...new Set(list)].slice(0, 6)
    }
    if (typeof patch.modelChainEnabled === 'boolean') next.modelChainEnabled = patch.modelChainEnabled
    if (typeof patch.autoRedeem === 'boolean') next.autoRedeem = patch.autoRedeem
    // 积分闸门：用户自己填的数（0 = 关闭）。负数按 0 处理，别静默丢掉整条更新。
    if (patch.creditFloor !== undefined) {
      const floor = Number(patch.creditFloor)
      if (Number.isFinite(floor)) next.creditFloor = Math.max(0, Math.round(floor))
    }
    // 旧参数照收（老页面还能改），但不参与决策。
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
      lastActiveAt: account.lastActiveAt,
      creditLow: this.belowFloor(account),
      expiresAt: account.auth?.expiresAt ?? null,
      hasRefreshToken: typeof account.auth?.refreshToken === 'string' && account.auth.refreshToken !== '',
      credits: account.credits,
      creditsAt: account.creditsAt,
      // 资源包明细（CodeBuddy个人版拉新权益包 / 国内运营裂变包 …）不再下发到页面。
      streakDays: account.streakDays,
      streakAt: account.streakAt,
      streakTiers: Array.isArray(account.streakTiers) ? account.streakTiers : undefined,
      // 「兑换 / 抽奖 / 活跃」三件事的最近一次结果，账号行里逐条显示。
      lastRedeem: account.lastRedeem,
      lastLottery: account.lastLottery,
      daily: account.daily ?? {},
      lastCheckin: account.lastCheckin,
      lastActivity: account.lastActivity,
      creditLog: Array.isArray(account.creditLog) ? account.creditLog.slice(-10) : [],
      // 今日各模型已花积分（纯展示，不参与切号）。
      todayModelSpend: account.modelUsage?.date === cstDay()
        ? Object.fromEntries(Object.entries(account.modelUsage).filter(([key, value]) => key !== 'date' && Number.isFinite(Number(value))))
        : undefined,
      // 今日已被上游禁用（或用户手动禁用）的模型：{ 模型id: { at, reason } }，跨天自动失效。
      modelBlocked: account.modelBlocked?.date === cstDay()
        ? Object.fromEntries(Object.entries(account.modelBlocked).filter(([key]) => key !== 'date'))
        : undefined,
    })
    // 刻意不返回 null 字段：浏览器侧只要按「有/没有」判断就绝不会踩到 null.ok 这类崩溃。
    return {
      settings: this.settings,
      // 积分闸门：用户自己填的数（0 / 未设 = 关闭）。页面可改，落盘持久。
      creditFloor: this.creditFloor,
      gate: {
        floor: this.creditFloor,
        enabled: this.creditFloor > 0,
      },
      // 模型轮换链的生效值：chain 是用户选定的顺序，enabled 表示这套轮换开没开。
      chain: {
        models: this.modelChain,
        enabled: this.modelChainEnabled,
      },
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
    lastActiveAt: Number(row.lastActiveAt) || undefined,
    addedAt: Number(row.addedAt) || Date.now(),
    lastLoginAt: Number(row.lastLoginAt) || undefined,
    credits: Number.isFinite(Number(row.credits)) ? Number(row.credits) : undefined,
    creditsAt: Number(row.creditsAt) || undefined,
    creditPackages: Array.isArray(row.creditPackages) ? row.creditPackages.slice(0, 5) : undefined,
    streakDays: Number.isFinite(Number(row.streakDays)) ? Number(row.streakDays) : undefined,
    streakAt: Number(row.streakAt) || undefined,
    streakTiers: Array.isArray(row.streakTiers) ? row.streakTiers.slice(0, 8) : undefined,
    lastRedeem: row.lastRedeem ?? undefined,
    lastLottery: row.lastLottery ?? undefined,
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
    modelBlocked: row.modelBlocked !== null && typeof row.modelBlocked === 'object' && !Array.isArray(row.modelBlocked)
      ? { ...row.modelBlocked }
      : undefined,
  }
}