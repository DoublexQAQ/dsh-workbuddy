/**
 * 导入 JSON 的形状归一层。
 *
 * 「方便使用」的意思就是：**别逼用户重新排版**。这个函数把该生态里所有常见的
 * 账号 JSON 形状收成插件内部形状 `{ auth, account, route }`：
 *
 * - 插件自己的导出：`{ accounts: [{ route, uid, nickname, auth, enterpriseId, domain }] }`（字段平铺）
 * - 别家网关的 session 文件（`~/.codebuddy-session.json`、`auths/workbuddy-<uid>.json`）：
 *   单个 `{ auth: { accessToken, refreshToken, expiresAt, domain }, account: { uid, nickname, enterpriseId } }`
 * - 裸数组 `[ {auth, account}, … ]`
 * - 蛇形键变体：`access_token` / `refresh_token` / `user_id` / `enterprise_id`
 * - 顶层直接给 token 的行：`{ accessToken, refreshToken, uid }`
 *
 * 路由归属：行上的 `route` / `platform` 字段认 `codebuddy` / `workbuddy`，
 * 也认它们的别名（`VSCode` → 国内、`workbuddy-ai` → 海外）；没有该字段默认国内。
 *
 * 校验从严：没有 accessToken 的行被**拒绝**并给原因——一个没有 token 的「账号」
 * 只会在第一次调用时才炸，且报错原因离真因很远。
 *
 * @module src/import.js
 */

function stringOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 把「路由/平台」字段翻成池子用的平台名；认不出来时返回 undefined 并给原文。 */
export function normalizeRoute(value) {
  const wanted = stringOf(value)
  if (wanted === undefined) return { route: 'codebuddy' }
  const lower = wanted.toLowerCase()
  if (lower === 'workbuddy' || lower === 'workbuddy-ai' || lower === 'intl' || lower === 'global') return { route: 'workbuddy' }
  if (lower === 'codebuddy' || lower === 'vscode' || lower === 'cn' || lower === 'domestic') return { route: 'codebuddy' }
  return { error: `无法识别的路由「${wanted}」（可用 codebuddy / workbuddy）` }
}

/** 秒/毫秒混用的过期时间统一成毫秒。 */
function expiryMs(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return numeric < 1e12 ? numeric * 1000 : numeric
}

/**
 * 一行账号 -> `{ auth, account, route }`，或 `{ error }`。
 *
 * @param {unknown} row
 */
export function normalizeImportRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return { error: '不是对象' }
  const record = /** @type {Record<string, any>} */ (row)
  const nested = record.account !== null && typeof record.account === 'object' && !Array.isArray(record.account) ? record.account : {}
  const authSource = record.auth !== null && typeof record.auth === 'object' && !Array.isArray(record.auth) ? record.auth : record
  const accessToken = stringOf(authSource.accessToken ?? authSource.access_token ?? authSource.token ?? authSource.jwt)
  if (accessToken === undefined) return { error: '缺少 auth.accessToken' }
  const refreshToken = stringOf(authSource.refreshToken ?? authSource.refresh_token)
  const domain = stringOf(authSource.domain ?? record.domain ?? nested.domain)
  const expiresAt = expiryMs(authSource.expiresAt ?? authSource.expires_at ?? record.expiresAt)
  const route = normalizeRoute(record.route ?? record.platform ?? nested.route ?? nested.platform)
  if (route.error !== undefined) return { error: route.error }
  const uid = stringOf(nested.uid ?? record.uid ?? nested.user_id ?? record.user_id ?? nested.userId ?? record.userId ?? nested.sub ?? record.sub)
  const nickname = stringOf(nested.nickname ?? record.nickname ?? nested.name ?? record.name)
  const enterpriseId = stringOf(nested.enterpriseId ?? record.enterpriseId ?? nested.enterprise_id ?? record.enterprise_id)
  return {
    auth: {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(domain === undefined ? {} : { domain }),
    },
    account: {
      ...(uid === undefined ? {} : { uid }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(enterpriseId === undefined ? {} : { enterpriseId }),
    },
    route: route.route,
  }
}

/**
 * 整个导入体 -> 行数组。
 *
 * @param {unknown} body
 * @returns {{rows: object[]}|{error: string}}
 */
export function normalizeImportInput(body) {
  if (Array.isArray(body)) return { rows: body }
  if (body === null || typeof body !== 'object') {
    return { error: '没有可导入的账号：需要 { accounts: [...] }、{ auth, account }、账号数组，或本插件的 accounts.json' }
  }
  if (Array.isArray(/** @type {any} */ (body).accounts)) return { rows: /** @type {any} */ (body).accounts }
  // 单个 session 文件（{auth, account}）或顶层直接给 token 的行
  const record = /** @type {any} */ (body)
  if (record.auth !== undefined || record.accessToken !== undefined || record.access_token !== undefined) return { rows: [body] }
  return { error: '没有可导入的账号：需要 { accounts: [...] }、{ auth, account }、账号数组，或本插件的 accounts.json' }
}

/**
 * 一批行 -> 可加入池子的行 + 带原因的跳过项。
 *
 * @param {object[]} rows
 * @param {(route: string) => boolean} routeEnabled - 该平台路由是否已启用
 * @returns {{accepts: Array<{auth: object, account: object, route: string}>, skipped: object[]}}
 */
export function prepareImportRows(rows, routeEnabled = () => true) {
  const accepts = []
  const skipped = []
  rows.forEach((raw, index) => {
    const label = raw?.account?.nickname ?? raw?.account?.uid ?? raw?.nickname ?? raw?.uid ?? `第 ${index + 1} 行`
    const normalized = normalizeImportRow(raw)
    if (normalized.error !== undefined) {
      skipped.push({ index, name: label, reason: normalized.error })
      return
    }
    if (routeEnabled(normalized.route) !== true) {
      skipped.push({ index, name: label, reason: `路由 ${normalized.route} 未启用（config.routes 里没有它）` })
      return
    }
    accepts.push(normalized)
  })
  return { accepts, skipped }
}