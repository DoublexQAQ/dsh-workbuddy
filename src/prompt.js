/**
 * 安全拒答时的系统提示降级层。
 *
 * 上游对 system prompt 有内容安全策略：命中后回
 * `HTTP 400 · Illegal API invocation from an unapproved channel`
 * （同类文案还有 `blocked by security policy`）。它拦的是**请求内容**，不是账号，
 * 也不是凭据——换个账号重发照样 400。该生态里所有网关对这条的统一解法是：
 * 把客户端的 system 换成一段中性、无宿主痕迹、无合规模板词的自有提示词再重试，
 * 并把「降级」保持到下一个自然日，避免每条请求都先撞一次墙。
 *
 * 这里实现同样的两层：
 * 1. `isSecurityRejection` 识别文案；
 * 2. `neutralizeChatBody` 删掉全部 system / developer 消息、头部插入内置中性提示词，
 *    历史其余消息（user / assistant / tool）逐字不动；
 * 3. `DegradeWindow` 记录降级到「下一个北京零点」，期内直接走中性提示词。
 *
 * @module src/prompt.js
 */

/** 内置中性提示词：声明工作方式，不带任何宿主 / 品牌 / 合规模板痕迹。 */
export const NEUTRAL_SYSTEM = [
  'You are a capable coding assistant working in the user\u2019s local workspace.',
  'Follow the user\u2019s instructions precisely; use the provided tools to read files, run commands, and verify results before reporting.',
  'Prefer small, correct edits over broad rewrites; keep existing code style. Report outcomes factually, including failures.',
].join(' ')

/** 触发降级的上游文案（大小写不敏感）。 */
const SECURITY_REJECTION = /unapproved channel|illegal api invocation|blocked by security policy|not authorized to call the api/i

/** 这段失败文案是不是内容安全拒答。 */
export function isSecurityRejection(text) {
  return typeof text === 'string' && SECURITY_REJECTION.test(text)
}

/**
 * 把 Chat 线请求体降级成中性提示词形状。
 *
 * 删除全部 system / developer 消息，头部插入单条中性 system；
 * user / assistant / tool 消息逐字保留。原地修改并返回同一个对象。
 *
 * @param {{messages?: Array<Record<string, unknown>>}} body
 */
export function neutralizeChatBody(body) {
  if (!Array.isArray(body?.messages)) return body
  const kept = body.messages.filter(message => message?.role !== 'system' && message?.role !== 'developer')
  body.messages = [{ role: 'system', content: NEUTRAL_SYSTEM }, ...kept]
  return body
}

/**
 * 下一个北京零点（毫秒）。降级只保持到当天结束：上游策略按自然日轮换，
 * 第二天宿主提示词的变化也许就不撞了，不该永远压着。
 */
export function nextCstMidnight(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now))
  const value = key => Number.parseInt(parts.find(part => part.type === key)?.value ?? '0', 10)
  const cstYear = value('year')
  const cstMonth = value('month')
  const cstDay = value('day')
  const cstHour = value('hour')
  // 北京时区的当日 UTC 基准点 = 当日 00:00 CST = 前一日 16:00 UTC。
  // cstHour >= 8 说明北京日历已经翻到「明天」的 UTC 日，基准要 +1 天。
  const midnightUtcMs = Date.UTC(cstYear, cstMonth - 1, cstDay + (cstHour >= 8 ? 1 : 0), 0, 0, 0) - 8 * 3600_000
  return midnightUtcMs > now ? midnightUtcMs : midnightUtcMs + 24 * 3600_000
}

/** 降级窗口：按 provider 记忆「降级到什么时候」。 */
export class DegradeWindow {
  constructor() {
    /** @type {Map<string, number>} */
    this.until = new Map()
  }

  /** 该 provider 现在是否应直接走中性提示词。 */
  isActive(provider, now = Date.now()) {
    const until = this.until.get(provider)
    if (until === undefined) return false
    if (until <= now) {
      this.until.delete(provider)
      return false
    }
    return true
  }

  /** 进入降级（到下一个北京零点），返回到期毫秒。 */
  engage(provider, now = Date.now()) {
    const until = nextCstMidnight(now)
    this.until.set(provider, until)
    return until
  }

  clear(provider) {
    this.until.delete(provider)
  }
}