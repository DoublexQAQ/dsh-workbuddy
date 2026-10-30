/**
 * dsh-workbuddy — 把 WorkBuddy / CodeBuddy 装进 DSH 的 Host 半身。
 *
 * 三件事，互相独立：
 *
 * 1. **模型车道**：两条 provider 路由（`workbuddy` 海外 / `codebuddy` 国内），
 *    出站按官方客户端对齐，上游看不到 DSH（见 `src/identity.js`、`src/sanitize.js`）。
 * 2. **账号池**：国内账号可以在设置页里**登录多个**，逐个切换 / 刷新 / 移除，
 *    模型调用用的是「当前账号」，被上游拒绝时自动轮换（见 `src/accounts.js`）。
 * 3. **每日积分**：按北京时区自然日自动跑签到 → 连登兑换 / 抽奖 → 活跃上报 → 余额回读，
 *    开机晚了会追赶，重启不会重复触发（见 `src/growth.js`、`src/schedule.js`）。
 *
 * 对宿主的依赖只有 `llm` 是硬的；`webServer` 走可选注入（没有 Web 服务时模型车道与
 * 每日任务照样工作，只是没有设置页那个入口）。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'

import { AccountsStore } from './src/accounts.js'
import { API_PREFIX, LoginCoordinator, createApiHandler } from './src/api.js'
import { WorkBuddyAdapter } from './src/adapter.js'
import { ModelCatalog, displayDescription, displayName } from './src/catalog.js'
import { IdentityStore } from './src/identity.js'
import { normalizeImportInput, prepareImportRows } from './src/import.js'
import { SessionStore, unwrapAuth } from './src/session.js'
import { reportActivity, runDailyGrowth, userResource } from './src/growth.js'
import { DailyScheduler, cstParts } from './src/schedule.js'
import { PLATFORMS, ROUTES as ALL_ROUTES, UPSTREAM_CODES } from './src/platform.js'

export const name = 'dsh-workbuddy'

/** 只有模型车道是硬依赖；Web 设置页与账号登录走可选注入。 */
export const inject = ['llm']

/** 积分任务只在国内平台有意义（海外平台的成长域结构不同）。 */
const GROWTH_PLATFORM = 'codebuddy'

const DEFAULTS = Object.freeze({
  routes: ALL_ROUTES,
  endpoints: {},
  /** 静态注入凭据（单账号；多账号请在设置页登录）。 */
  token: undefined,
  refreshToken: undefined,
  userId: undefined,
  domain: undefined,
  enterpriseId: undefined,
  autoLogin: true,
  openBrowser: true,
  /** 授权等待放宽到 5 分钟：浏览器登录 + 扫码 + 确认，3 分钟太容易掐表。 */
  loginTimeoutMs: 300_000,
  loginPollIntervalMs: 1_500,
  loginOnStart: false,
  requestTimeoutMs: 120_000,
  gzipThresholdBytes: 4_096,
  keepAlive: true,
  autoRefresh: true,
  /** 当前账号被拒时自动切到下一个启用账号。 */
  failover: true,
  /**
   * 模型车道的积分下限：已知余额低于这个数的账号**不再用于聊天调用**，
   * 自动切到同路由里够的账号；全都低于就报错停用，等签到回血或充值自动恢复。
   * `0` = 关闭闸门。只闸模型车道——每日签到 / 余额刷新照常跑（那正是回血途径）。
   */
  creditFloor: 100,
  contextWindow: undefined,
  maxTokens: undefined,
  stateDir: undefined,
  sessionFile: undefined,
  deviceToken: undefined,
  deviceTokenFile: undefined,
  userAgent: undefined,
  cliUserAgent: undefined,
  conversationIdFormat: 'uuid',
  headerExtras: undefined,
  bodyExtras: undefined,
  sanitize: { scrub: true, desensitize: true, scrubUser: false },
  /** `passthrough` 关闭内容安全降级（保持客户端 system 原样，被上游拦就直接报错）。 */
  promptMode: 'auto',
  traceOutbound: false,
  /** 每日积分任务。 */
  autoCheckin: true,
  checkinHours: [9, 21],
  autoActivity: true,
  activityHours: [10],
  autoGrowth: true,
  checkinBases: undefined,
  maxLotteryDraws: 20,
  /** 上游模型目录的缓存时长／要从选择器里隐藏的模型 id。 */
  catalogTtlMs: 600_000,
  hideModels: [],
  /** 路由名映射：`{ codebuddy: 'my-codebuddy' }` 可让两条路由与别的插件并存。 */
  routeNames: undefined,
  scheduleIntervalMs: 60_000,
})

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  // 路由名可改（routeNames）：别人机器上若已有插件占了 `workbuddy` / `codebuddy`，
  // 换个名字就能并存——两条路由都能装进同一个 llm 注册表。
  const routeNameOverrides = settings.routeNames ?? {}
  const nameFor = platform => {
    const value = routeNameOverrides[platform]
    return typeof value === 'string' && value !== '' ? value : platform
  }
  const platformOf = routeName => ALL_ROUTES.find(platform => nameFor(platform) === routeName)
  const routeLabelFor = routeName => PLATFORMS[platformOf(routeName)]?.label ?? routeName
  const routes = (Array.isArray(settings.routes) && settings.routes.length > 0 ? settings.routes : ALL_ROUTES.map(nameFor))
    .filter(route => platformOf(route) !== undefined)
  if (routes.length === 0) {
    logger.warn?.('workbuddy: 没有可用的平台路由，插件不注册任何 provider')
    return
  }
  /** 积分任务只在国内平台有意义（海外平台的成长域结构不同）。 */
  const growthRoute = nameFor(GROWTH_PLATFORM)

  const resolvedStateDir = settings.stateDir ? path.resolve(settings.stateDir) : defaultStateDir()
  try {
    fs.mkdirSync(resolvedStateDir, { recursive: true })
  } catch (error) {
    logger.warn?.(`workbuddy: 无法创建状态目录 ${resolvedStateDir}（${error instanceof Error ? error.message : String(error)}）`)
  }

  const profileFor = route => {
    const base = PLATFORMS[platformOf(route)]
    if (base === undefined) return undefined
    const endpoint = settings.endpoints?.[route] ?? base.endpoint
    return {
      ...base,
      endpoint: String(endpoint).replace(/\/+$/, ''),
      ...(typeof settings.userAgent === 'string' && settings.userAgent !== '' ? { userAgent: settings.userAgent } : {}),
    }
  }

  // ── 账号池 ──────────────────────────────────────────────────────────────────
  const accounts = new AccountsStore({
    file: path.join(resolvedStateDir, 'accounts.json'),
    logger,
    creditFloor: Number(settings.creditFloor ?? 0),
    settings: {
      autoCheckin: settings.autoCheckin !== false,
      checkinHours: settings.checkinHours,
      autoActivity: settings.autoActivity !== false,
      activityHours: settings.activityHours,
      autoGrowth: settings.autoGrowth !== false,
    },
  })

  /** @type {Map<string, SessionStore>} */
  const sessions = new Map()
  const sessionFor = route => {
    let store = sessions.get(route)
    if (store === undefined) {
      store = new SessionStore({ profile: profileFor(route), config: settings, logger })
      store.attachAccounts(accounts)
      // 登录成功 -> 并入池子。**池子按平台名（codebuddy / workbuddy）分组**——
      // 账号是平台相关的资产，注册路由改名（routeNames）不影响池子归属。
      store.onLoginSuccess = ({ auth, account, route }) => {
        const { account: row, created } = accounts.add({ auth, account, route: route ?? GROWTH_PLATFORM })
        invalidateCatalog()
        if (created) logger.info?.(`workbuddy: 已登录并加入账号池：${row.nickname ?? row.uid ?? row.id}（${row.route}）`)
      }
      sessions.set(route, store)
    }
    return store
  }

  /** @type {Map<string, IdentityStore>} */
  const identities = new Map()
  const identityFor = route => {
    let store = identities.get(route)
    if (store === undefined) {
      store = new IdentityStore(path.join(resolvedStateDir, `${route}-conversations.json`), { logger })
      identities.set(route, store)
    }
    return store
  }

  // ── 出站诊断 ────────────────────────────────────────────────────────────────
  const traceFile = settings.traceOutbound ? path.join(resolvedStateDir, 'outbound.jsonl') : undefined
  const redactBody = body => {
    if (body === null || typeof body !== 'object') return body
    if (Array.isArray(body)) return body.map(redactBody)
    const out = {}
    for (const [key, value] of Object.entries(body)) {
      if (/token|authorization|device/i.test(key)) out[key] = '<redacted>'
      else if (key === 'messages' && Array.isArray(value)) out[key] = `[${value.length} messages]`
      else out[key] = redactBody(value)
    }
    return out
  }
  const record = event => {
    if (traceFile === undefined) return
    try {
      fs.appendFileSync(traceFile, `${JSON.stringify({ ...event, body: redactBody(event.body) })}\n`)
    } catch {
      /* 诊断落盘失败不影响模型车道 */
    }
  }

  const catalog = new ModelCatalog({ ttlMs: Number(settings.catalogTtlMs ?? 10 * 60_000), logger })
  /** 账号集变化（登录 / 导入 / 移除）后清掉目录缓存：倍率是按账号权限下发的。 */
  function invalidateCatalog() {
    catalog.cache.clear()
  }
  // 站点专属指纹（某台机器装的人格 / 注入文案）走**本机状态目录**，不进仓库也不进 patch：
  // `~/.dsh-workbuddy/sanitize.json` -> `{ extraRules: [...], words: [...] }`。
  const localSanitize = readSanitizeOverride(resolvedStateDir, logger)
  const sanitize = {
    ...(settings.sanitize ?? {}),
    extraRules: [...(settings.sanitize?.extraRules ?? []), ...(localSanitize.extraRules ?? [])],
    ...(localSanitize.words === undefined
      ? {}
      : { words: [...(settings.sanitize?.words ?? []), ...localSanitize.words] }),
  }
  const adapterSettings = { ...settings, sanitize }
  const adapter = new WorkBuddyAdapter({ profileFor, sessionFor, identityFor, accounts, catalog, config: adapterSettings, logger, record })

  // ── 模型车道注册 ────────────────────────────────────────────────────────────
  // 逐条注册：一条路由被别的插件占了（DUPLICATE_ADAPTER），只跳过它，
  // 不让整块激活失败——「因为插件冲突整个用不了」是最不值得的失败方式。
  for (const route of routes) {
    try {
      const dispose = ctx.llm.registerAdapter([route], adapter)
      ctx.effect(() => () => dispose(), `dsh-workbuddy: adapter route ${route}`)
    } catch (error) {
      logger.warn?.(
        `workbuddy: 路由 "${route}" 未能注册（${error instanceof Error ? error.message : String(error)}）——`
        + '可能已被另一个插件占用；其余路由继续。可用 config.routeNames 给它换个名字。',
      )
    }
  }

  if (typeof ctx.llm.registerConfigurableProviders === 'function') {
    for (const route of routes) {
      try {
        const directory = ctx.llm.registerConfigurableProviders([
          {
            provider: route,
            displayName: routeLabelFor(route),
            settingsNs: ctx.fiber?.entry?.options?.id ?? name,
            settingsPath: [],
          },
        ])
        ctx.effect(() => () => directory(), `dsh-workbuddy: configurable provider ${route}`)
      } catch (error) {
        logger.debug?.(`workbuddy: 路由 "${route}" 未能登记到模型设置目录（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }

  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    ctx.llm.registerModelDiscovery(ctx.fiber?.entry?.options?.id ?? name, async (request, signal) => {
      const route = resolveRoute(request?.provider, routes)
      const profile = profileFor(route)
      const session = sessionFor(route)
      const discovered = []
      let rows = []
      try {
        const credentials = await session.ensureAuth({ signal })
        const account = accounts.active(route)
        const fetched = await catalog.get({ route, account, auth: credentials, config: settings, signal, force: true })
        rows = Array.isArray(fetched.rows) ? fetched.rows : []
        if (rows.length === 0) logger.debug?.(`workbuddy: 上游模型目录为空（${fetched.error ?? '未知原因'}），回落到静态表`)
      } catch (error) {
        logger.warn?.(`workbuddy: 模型探测前未能取得凭据（${error instanceof Error ? error.message : String(error)}）`)
      }
      for (const row of rows) {
        discovered.push({
          id: row.id,
          // 探测列表同样带计价，用户在这里挑模型时就能看出是不是免费。
          name: displayName(row),
          description: displayDescription(row),
          contextWindow: row.contextWindow,
          maxTokens: row.maxOutput,
          inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
        })
      }
      const seen = new Set(discovered.map(row => row.id))
      for (const entry of profile.models ?? []) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        discovered.push({
          id: entry.id,
          name: `${entry.name} · 倍率未知`,
          contextWindow: Number(entry.contextWindow) || Number(settings.contextWindow) || undefined,
          maxTokens: Number(entry.maxOutput) || Number(settings.maxTokens) || undefined,
          inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        })
      }
      return discovered
    })
  }

  // ── 积分任务 ────────────────────────────────────────────────────────────────
  const growthConfig = {
    ...settings,
    get autoGrowth() {
      return accounts.settings.autoGrowth !== false
    },
    get autoActivity() {
      return accounts.settings.autoActivity !== false
    },
  }

  /**
   * 跑任务。`account` 省略即对全部启用账号跑一遍（每个账号按**它自己的平台**发请求：
   * 账号池里国内、国际混着放，国际账号的 token 拿去国内计费域只会 401）。
   * 活跃上报只对国内有意义，国际账号自动跳过并说明。
   *
   * @param {{account?: object, kind: 'checkin'|'credits'|'refresh'|'activity'}} input
   */
  async function runTask({ account, kind }) {
    const targets = account !== undefined ? [account] : accounts.enabled()
    if (targets.length === 0) return { results: [], skipped: 'no-accounts' }
    const results = []
    for (const target of targets) {
      const label = target.nickname ?? target.uid ?? target.id
      const platform = target.route === 'workbuddy' ? 'workbuddy' : 'codebuddy'
      if (kind === 'activity' && platform !== 'codebuddy') {
        results.push({ id: target.id, name: label, kind, ok: false, skipped: true, message: '国际版没有活跃上报任务，已跳过' })
        continue
      }
      try {
        const session = sessionFor(nameFor(platform))
        const credentials = await session.credentialsFor(target)
        if (credentials.accessToken === undefined) {
          results.push({ id: target.id, name: label, kind, ok: false, message: '没有可用凭据（请重新登录该账号）' })
          continue
        }
        const deviceToken = session.deviceToken()

        if (kind === 'refresh') {
          const ok = await session.refreshAccount(target)
          results.push({ id: target.id, name: label, kind, ok, message: ok ? '凭据已刷新' : '刷新失败' })
          continue
        }
        if (kind === 'credits') {
          const balance = await userResource({ session: credentials, deviceToken, config: growthConfig, platform })
          if (balance.ok === true) {
            accounts.update(target.id, { credits: balance.credits, creditsAt: Date.now(), creditPackages: balance.packages })
          }
          results.push({ id: target.id, name: label, kind, platform, ok: balance.ok === true, message: balance.message, credits: balance.credits, packages: balance.packages })
          continue
        }
        if (kind === 'activity') {
          const activity = await reportActivity({ session: credentials, config: growthConfig })
          accounts.update(target.id, { lastActivity: { at: Date.now(), ok: activity.ok === true, message: activity.message } })
          results.push({ id: target.id, name: label, kind, ok: activity.ok === true, message: activity.message })
          continue
        }

        const daily = await runDailyGrowth({ session: credentials, deviceToken, config: growthConfig, platform })
        accounts.update(target.id, {
          ...(daily.checkin === undefined
            ? {}
            : { lastCheckin: { at: daily.at, ok: daily.checkin.ok === true, already: daily.checkin.already === true, unavailable: daily.checkin.unavailable === true, credit: daily.checkin.credit, message: daily.checkin.message } }),
          ...(daily.activity === undefined ? {} : { lastActivity: { at: daily.at, ok: daily.activity.ok === true, message: daily.activity.message } }),
          ...(daily.credits === undefined ? {} : { credits: daily.credits, creditsAt: daily.at }),
          ...(daily.packages === undefined ? {} : { creditPackages: daily.packages }),
          ...(daily.streakDays === undefined ? {} : { streakDays: daily.streakDays, streakAt: daily.at }),
          daily: { ...(target.daily ?? {}), checkin: cstParts(daily.at ?? Date.now()).date },
        })
        results.push({
          id: target.id,
          name: label,
          kind,
          platform,
          ok: daily.checkin?.ok === true,
          message: daily.checkin?.message ?? '完成',
          credit: daily.checkin?.credit,
          streakDays: daily.streakDays,
          credits: daily.credits,
          redeem: daily.redeem,
          lottery: daily.lottery,
        })
      } catch (error) {
        results.push({ id: target.id, name: label, kind, ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { results }
  }

  const scheduler = new DailyScheduler({
    accounts,
    logger,
    intervalMs: Number(settings.scheduleIntervalMs ?? 60_000),
    run: async (account, kind) => {
      // 签到时点跑的是完整闭环（签到 + 连登兑换/抽奖 + 活跃 + 余额）；
      // 活跃时点只补一条上报，避免每小时重复签到。
      const outcome = await runTask({ account, kind: kind === 'activity' ? 'activity' : 'checkin' })
      const row = Array.isArray(outcome?.results) ? outcome.results[0] : undefined
      logger.info?.(`workbuddy: ${kind}（${account.nickname ?? account.uid ?? account.id}）：${row?.message ?? '完成'}`)
    },
  })
  scheduler.start(ctx)

  // ── 设置页的同源接口 ────────────────────────────────────────────────────────
  /** 每个**已启用**的平台路由一个登录协调器；页面用平台名（codebuddy / workbuddy）点名。 */
  const logins = {}
  for (const platform of ALL_ROUTES) {
    const route = nameFor(platform)
    if (routes.includes(route) !== true) continue
    logins[platform] = new LoginCoordinator({
      logger,
      begin: async ({ onProgress }) => sessionFor(route).login({ onProgress }),
    })
  }

  /**
   * 导入 JSON 凭据（页面粘贴 / 别家网关的 session 文件都行）。
   *
   * 形状归一全在 `src/import.js`：本插件导出的 accounts.json、别家网关的
   * `{auth, account}`、裸数组、蛇形键变体都收。校验从严：没有 accessToken 的行
   * 被**拒绝**并点名原因——一个没有 token 的「账号」只会在第一次调用时才炸。
   *
   * @param {unknown} body - 页面 POST 来的整个 JSON
   * @returns {{imported: number, created: number, skipped: object[]}}
   */
  function importAccounts(body) {
    const normalized = normalizeImportInput(body)
    if (normalized.error !== undefined) throw new Error(normalized.error)
    if (normalized.rows.length > 50) throw new Error('一次最多导入 50 个账号')
    const { accepts, skipped } = prepareImportRows(normalized.rows, platform => logins[platform] !== undefined)
    let created = 0
    for (const row of accepts) {
      const outcome = accounts.add({ auth: row.auth, account: row.account, route: nameFor(row.route) })
      if (outcome.created) created += 1
      logger.info?.(`workbuddy: 导入账号 ${row.account.nickname ?? row.account.uid ?? row.account.accessToken.slice(0, 8)}…（${row.route}）`)
    }
    return { imported: accepts.length, created, skipped }
  }

  /**
   * 设置页用的模型目录视图（含免费标记与倍率）。
   *
   * 倍率是按账号权限下发的，所以用「本路由的当前账号」去读；国内路由没有账号时
   * 退到任意一条有账号的路由——页面至少能告诉用户当前账号能看到什么。
   *
   * @param {{force?: boolean}} [options]
   */
  async function catalogView(options = {}) {
    const route = accounts.enabled(growthRoute).length > 0
      ? growthRoute
      : routes.find(candidate => accounts.enabled(candidate).length > 0)
    if (route === undefined) return { rows: [], error: '还没有登录账号', at: Date.now() }
    const account = accounts.active(route)
    try {
      const credentials = await sessionFor(route).credentialsFor(account)
      const fetched = await catalog.get({ route, account, auth: credentials, config: settings, force: options.force === true })
      return {
        route,
        at: fetched.at,
        error: fetched.error,
        rows: (fetched.rows ?? []).map(row => ({
          id: row.id,
          name: row.name,
          credits: row.credits,
          free: row.free === true,
          contextWindow: row.contextWindow,
          maxOutput: row.maxOutput,
          vendor: row.vendor,
          thinking: row.thinking === true,
          thinkingMandatory: row.thinkingMandatory === true,
          vision: row.vision === true,
        })),
      }
    } catch (error) {
      return { route, rows: [], error: error instanceof Error ? error.message : String(error), at: Date.now() }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      const dispose = scoped.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createApiHandler({
          accounts,
          logins,
          routeNameFor: nameFor,
          runTask,
          catalog: catalogView,
          importAccounts,
          invalidate: invalidateCatalog,
          logger,
          config: settings,
        }),
      })
      ctx.effect(() => () => dispose(), 'dsh-workbuddy: settings api')
    })
  } else {
    logger.warn?.('workbuddy: 这个组合没有 webServer，设置页不可用；模型车道与每日任务不受影响')
  }

  if (settings.loginOnStart === true) {
    ctx.effect(() => {
      let disposed = false
      void (async () => {
        try {
          if (!disposed) await sessionFor(growthRoute).ensureAuth({})
        } catch (error) {
          logger.warn?.(`workbuddy: 启动登录未完成（${error instanceof Error ? error.message : String(error)}）`)
        }
      })()
      return () => {
        disposed = true
      }
    }, 'dsh-workbuddy: login-on-start')
  }

  logger.info?.(
    `workbuddy: 已注册 ${routes.length} 条 provider 路由（${routes.join(', ')}），账号池 ${accounts.all().length} 个账号，`
    + `每日积分任务 ${accounts.settings.autoCheckin === false ? '关' : `开（${(accounts.settings.checkinHours ?? []).join('/')} 点）`}`,
  )
}

/** 默认状态目录：`~/.dsh-workbuddy`。 */
function defaultStateDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
  return path.join(home, '.dsh-workbuddy')
}

/**
 * 读本机的指纹清洗覆盖（`<stateDir>/sanitize.json`）。
 *
 * 这是「本机的东西」唯一该待的地方：仓库与 patch 只放通用默认值，
 * 某个 profile 额外装的人格 / 注入文案写在用户自己的状态目录里。
 *
 * 形状：`{ extraRules: [{pattern, flags?, replacement?, why?}], words: ["自定义词"] }`
 *
 * @param {string} stateDir
 * @param {{warn?: Function, debug?: Function}} [logger]
 * @returns {{extraRules?: object[], words?: string[]}}
 */
function readSanitizeOverride(stateDir, logger) {
  const file = path.join(stateDir, 'sanitize.json')
  if (fs.existsSync(file) !== true) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const extraRules = Array.isArray(parsed?.extraRules) ? parsed.extraRules : undefined
    const words = Array.isArray(parsed?.words) ? parsed.words.filter(word => typeof word === 'string' && word !== '') : undefined
    const count = (extraRules?.length ?? 0) + (words?.length ?? 0)
    if (count > 0) logger?.debug?.(`workbuddy: 已加载本机指纹清洗覆盖 ${file}（${count} 条）`)
    return {
      ...(extraRules === undefined ? {} : { extraRules }),
      ...(words === undefined ? {} : { words }),
    }
  } catch (error) {
    logger?.warn?.(`workbuddy: ${file} 读取失败（${error instanceof Error ? error.message : String(error)}），已忽略`)
    return {}
  }
}

/** 从探测请求里推断路由。 */
function resolveRoute(provider, routes) {
  if (typeof provider === 'string' && routes.includes(provider)) return provider
  if (typeof provider === 'string') {
    const stripped = provider.replace(/-region$/, '')
    if (routes.includes(stripped)) return stripped
  }
  return routes[0]
}

export { GROWTH_PLATFORM }