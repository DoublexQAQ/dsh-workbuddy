/**
 * 平台档案：把 WorkBuddy / CodeBuddy 两个官方后端描述成一张表。
 *
 * 表里每一行都是「官方客户端会怎么发请求」的事实，来源是该生态里可核对的抓包/逆向记录
 * （见 README「事实来源」一节），不是推测：
 *
 * - 国内 CodeBuddy：`https://copilot.tencent.com`，认证 platform `VSCode`，
 *   官方 UA 必须是 `CodeBuddyIDE/<version>`（否则 HTTP 400 code 12403 `check ua`），
 *   并且带 `x-device-token`（一设备一账号，账号与设备绑定）。
 * - 海外 WorkBuddy AI：`https://www.workbuddy.ai`，认证 platform `workbuddy-ai`，
 *   **不存在** `x-device-token`（官方客户端本身不产这个头），只有 JWT。
 *
 * 两个平台共用同一套认证协议（`cli-external-link`，`/v2/plugin/` 前缀）与同一个
 * 推理入口 `POST /v2/chat/completions`（上游本身就是标准 OpenAI chat 协议）。
 *
 * @module src/platform.js
 */

/**
 * 官方客户端的版本串。国内这条是 UA 门禁的一部分，不能随便改。
 *
 * 国际版 UA 是**实测值**（2026-10-31 逐组验证）：三段式全小写
 * `workbuddy-ai/<ide> workbuddy-ai/<ide> CLI/<cli>`。旧值 `WorkBuddy/5.5.2 …`
 * 来自二手文档，上游不认（chat 直接 `request illegal`、/v3/config check ua 也看它）。
 */
export const CN_PRODUCT_VERSION = '4.12.0'
export const CN_USER_AGENT = `CodeBuddyIDE/${CN_PRODUCT_VERSION}`
export const INTL_IDE_VERSION = '5.7.6'
export const INTL_CLI_VERSION = '2.156.0'
export const INTL_USER_AGENT = `workbuddy-ai/${INTL_IDE_VERSION} workbuddy-ai/${INTL_IDE_VERSION} CLI/${INTL_CLI_VERSION}`

/**
 * 海外版**绝不发送**的头。官方抓包的包头集合里没有这几个，多发一个就是特征差异。
 * （`accept-encoding` 由本地 HTTP 层按需补 gzip，同样属于必须剥离的宿主默认头。）
 */
export const INTL_FORBIDDEN_HEADERS = Object.freeze([
  'x-model-id',
  'x-request-trace-id',
  'accept-language',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-dest',
  'monitor_httpsendtime',
  'acp-connection-id',
])

/**
 * 出站头白名单之外的**宿主指纹**头。任何名字命中这些片段的头都不允许上线，
 * 它们正是「被代理到 DSH」的可观测证据。
 *
 * ⚠️ 不包含 `x-agent`：实测（2026-10-31）官方 intl chat 自己就发
 * `x-agent-intent` / `x-agent-purpose` / `x-agent-type`——它是官方指纹的一部分。
 */
export const HOST_FINGERPRINT_HEADERS = Object.freeze([
  'user-agent-attribution',
  'x-dsh',
  'x-deepseek',
  'deepseek-harness',
  'x-harness',
  'x-opencode',
  'x-client-name',
  'x-session-affinity-source',
])

const CN_MODELS = [
  { id: 'auto', name: 'Auto' },
  { id: 'default', name: 'Default', efforts: true },
  { id: 'fast-model', name: 'Fast' },
  { id: 'balanced-model', name: 'Balanced' },
  { id: 'deep-model', name: 'Deep', efforts: true },
  { id: 'hy4-preview', name: 'Hy4 preview', efforts: true },
  { id: 'hy4-preview-f', name: 'Hy4 preview (fast)', efforts: true },
  { id: 'hy3', name: 'Hy3', efforts: true },
  { id: 'hy3-x', name: 'Hy3-X', efforts: true },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos' },
  { id: 'glm-5.3', name: 'GLM-5.3', efforts: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-flash', efforts: true },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', efforts: true },
  { id: 'glm-5.2', name: 'GLM-5.2', efforts: true },
  // glm-5.1 必须携带 reasoning_effort（上游 code 11150），适配器会自动补 medium。
  { id: 'glm-5.1', name: 'GLM-5.1', efforts: true, requireEffort: true },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', efforts: true, vision: true },
  { id: 'kimi-k3', name: 'Kimi-K3', efforts: true },
  { id: 'kimi-k3-1', name: 'Kimi-K3.1', efforts: true },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', efforts: true },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', efforts: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'minimax-m3', name: 'MiniMax-M3', efforts: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
  { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6-Pro' },
  { id: 'step-5-preview', name: 'Step-5-Preview', efforts: true },
  { id: 'space-bunny', name: 'Space-Bunny', efforts: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', efforts: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', efforts: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', efforts: true },
  { id: 'codewise-rewrite', name: 'codewise-rewrite' },
  { id: 'codewise-jump', name: 'codewise-jump' },
  { id: 'nes-gf', name: 'nes-gf' },
]

const INTL_MODELS = [
  { id: 'default-model', name: 'Auto', efforts: true },
  { id: 'fast-model', name: 'Fast' },
  { id: 'balanced-model', name: 'Balanced' },
  { id: 'auto', name: 'Auto' },
  { id: 'hy4-preview', name: 'Hy4 preview', efforts: true },
  { id: 'hy4-preview-f', name: 'Hy4 preview (fast)', efforts: true },
  { id: 'hy3', name: 'Hy3', efforts: true },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', efforts: true },
  { id: 'glm-5.3', name: 'GLM-5.3', efforts: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-flash', efforts: true },
  { id: 'glm-5.2', name: 'GLM-5.2', efforts: true },
  { id: 'glm-5.1', name: 'GLM-5.1', efforts: true, requireEffort: true },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', efforts: true, vision: true },
  { id: 'kimi-k3', name: 'Kimi-K3', efforts: true },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', efforts: true },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', efforts: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'minimax-m3', name: 'MiniMax-M3', efforts: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash' },
  { id: 'space-bunny', name: 'Space-Bunny', efforts: true },
  { id: 'step-5-preview', name: 'Step-5-Preview', efforts: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', efforts: true },
]

/**
 * 两个平台档案。键就是插件在 DSH 里注册的 provider 路由名。
 */
export const PLATFORMS = {
  workbuddy: {
    route: 'workbuddy',
    label: 'WorkBuddy AI',
    endpoint: 'https://www.workbuddy.ai',
    platform: 'workbuddy-ai',
    defaultSessionFile: '.workbuddy-ai-session.json',
    defaultDeviceTokenFile: '',
    userAgent: INTL_USER_AGENT,
    product: 'SaaS',
    productVersion: INTL_IDE_VERSION,
    ideType: 'WorkBuddy',
    ideName: 'WorkBuddy',
    ideVersion: INTL_IDE_VERSION,
    deviceToken: false,
    // 实测（2026-10-31）intl chat 必发的会话 id 族：`x-conversation-id` +
    // `x-conversation-message-id` + `x-conversation-request-id`（32hex）。
    // 缺任何一个 → 400 request illegal。
    officialChatIds: true,
    // messages 首条必须是 system；缺了 → 400 first message is not system prompt。
    requiresSystemFirst: true,
    // 官方 intl chat 连流式请求的 accept 都是 application/json（实测两种都通，按官方）。
    chatAccept: 'application/json',
    forbidHeaders: INTL_FORBIDDEN_HEADERS,
    chatPath: '/v2/chat/completions',
    configPath: '/v3/config?repos=',
    models: INTL_MODELS,
  },
  codebuddy: {
    route: 'codebuddy',
    label: 'CodeBuddy (国内)',
    endpoint: 'https://copilot.tencent.com',
    platform: 'VSCode',
    defaultSessionFile: '.codebuddy-session.json',
    defaultDeviceTokenFile: '.codebuddy-device-token.json',
    userAgent: CN_USER_AGENT,
    product: 'SaaS',
    productVersion: CN_PRODUCT_VERSION,
    ideType: 'VSCode',
    ideName: 'VSCode',
    ideVersion: '1.70.2',
    deviceToken: true,
    forbidHeaders: Object.freeze([]),
    chatPath: '/v2/chat/completions',
    configPath: '/v3/config?repos=',
    models: CN_MODELS,
  },
}

/** 注册进 DSH 的全部 provider 路由。 */
export const ROUTES = Object.keys(PLATFORMS)

/** 路由的展示名。 */
export const ROUTE_LABELS = Object.fromEntries(ROUTES.map(route => [route, PLATFORMS[route].label]))

/**
 * 上游错误码 -> 失败语义。数字取自该生态的实测记录。
 *
 * @type {Record<string, {code: string, retryable: boolean, reason: string}>}
 */
export const UPSTREAM_CODES = Object.freeze({
  11102: { code: 'MODEL', retryable: false, reason: '模型不存在或已下线' },
  11103: { code: 'CLIENT', retryable: false, reason: '后端不支持该调用方式' },
  11134: { code: 'SERVER', retryable: true, reason: '上游临时不可用' },
  11150: { code: 'CLIENT', retryable: false, reason: 'reasoning effort 不支持（glm-5.1 需自动补 medium）' },
  11158: { code: 'PERMISSION', retryable: false, reason: '当前账号类型不允许使用该模型' },
  12403: { code: 'CLIENT', retryable: false, reason: 'User-Agent 校验失败（必须 CodeBuddyIDE/<version>）' },
  6004: { code: 'RATE_LIMIT', retryable: false, reason: '上游频控，需要冷却' },
  14003: { code: 'RATE_LIMIT', retryable: false, reason: '模型级瞬时限流，短冷却可恢复' },
})

/** 默认上下文窗口（上游 /v3/config 有值时以它为准）。 */
export const DEFAULT_CONTEXT_WINDOW = 131072
export const DEFAULT_MAX_OUTPUT = 16384

/** DSH 的 reasoning effort id <-> 上游 `reasoning_effort` 字面量。 */
export const EFFORT_MAP = Object.freeze({ low: 'low', medium: 'medium', high: 'high' })

/** 一个模型行的展示信息。 */
export function describeModel(entry) {
  return entry.description ?? (entry.efforts ? '思考强度可调' : undefined)
}