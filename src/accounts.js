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
})

export class AccountsStore {
  /**
   * @param {object} input
   * @param {string} input.file
   * @param {{debug?: Function, warn?: Function, info?: Function}} [input.logger]
   * @param {object} [input.settings] - 每日任务的初始设置（来自插件 config）
   */
  constructor({ file, logger, settings = {} }) {
    this.file = file
    this.logger = logger ?? {}
    this.settings = { ...DEFAULT_DAILY_SETTINGS, ...settings }
    /** @type {Array<object>} */
    this.accounts = []
    this.load()
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
    // 同一路由内只保留一个「当前」。
    for (const other of this.accounts) if (other.route === route) other.active = other.id === row.id
    this.accounts.push(row)
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

  /** 轮换到同路由的下一个启用账号（故障转移用）。返回新当前账号。 */
  rotate(from) {
    if (from === undefined) return undefined
    const pool = this.enabled(from.route)
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
    this.settings = next
    this.save()
    return next
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
    })
    // 刻意不返回 null 字段：浏览器侧只要按「有/没有」判断就绝不会踩到 null.ok 这类崩溃。
    return {
      settings: this.settings,
      accounts: this.accounts.map(account => stripEmpty(view(account))),
    }
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
    lastError: row.lastError ?? undefined,
  }
}