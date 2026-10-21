/**
 * 出站提示词的指纹清洗层。
 *
 * 请求头对齐只是「像官方客户端」的一半，另一半在**正文里**。DSH 会把宿主身份写进
 * system prompt（归属串、产品名、插件名、工作目录，以及某些 profile 里额外注入的人格文案），
 * 上游的风控读的正是这一段：命中客户端指纹的请求会被判成「非官方客户端
 * 调用」并直接拦在推理之前（该生态里记录的 11128 类拦截就是这一类）。
 *
 * 因此这一层做两件事，都只作用于 system / developer 消息：
 *
 * 1. **指纹改写**：把可识别的宿主字符串换成语义等价的中性表述。不是删掉整段
 *    系统提示（那会改变模型行为），只摘掉身份词。
 * 2. **合规词脱敏**：对合规声明里的品牌词与安全术语插入零宽空格（U+200B），
 *    打断上游的关键词匹配。人读与模型读都没有差别，逐字匹配失效。
 *    这是该生态里被反复验证的做法，默认开启，可关。
 *
 * ⚠️ 真实用户输入原样透传：这里不碰 user / tool 内容，除了可选的
 * `scrubUser` 开关（默认关）。
 *
 * @module src/sanitize.js
 */

/** 零宽空格。插进词里，肉眼与分词器都看不见它。 */
export const ZWSP = '\u200B'

/**
 * 指纹改写表。顺序即优先级：先删整串归属，再收窄产品词。
 *
 * 这些字符串是**本宿主**在 system prompt 里会留下的痕迹：
 * 内核归属头、DSH 产品名、插件名、以及本 profile 装的人格注入文案。
 *
 * @type {ReadonlyArray<{pattern: RegExp, replacement: string, why: string}>}
 */
export const FINGERPRINT_REWRITES = Object.freeze([
  { pattern: /deepseek-harness\/[0-9][^\s)]*(\s*\(\+https:\/\/github\.com\/deepseek-ai\/deepseek-harness\))?/gi, replacement: '', why: '内核归属 UA 字面量' },
  { pattern: /https:\/\/github\.com\/deepseek-ai\/deepseek-harness/gi, replacement: '', why: '内核仓库地址' },
  { pattern: /deepseek[- ]harness/gi, replacement: 'the local client', why: '宿主产品名' },
  { pattern: /deepseek\s+desktop/gi, replacement: 'local desktop', why: '宿主安装路径名' },
  { pattern: /\bDSH\s*NEXT\b/g, replacement: 'the local app', why: '宿主版本目录名' },
  { pattern: /\bDSH\b/g, replacement: 'the client', why: '宿主缩写' },
  { pattern: /\.dsh\b/g, replacement: '.config', why: '宿主配置目录名' },
  { pattern: /app\.asar(\.unpacked)?/gi, replacement: 'app', why: '宿主打包特征' },
  { pattern: /dsh-[a-z0-9-]+/gi, replacement: 'the plugin', why: '宿主插件命名空间' },
  { pattern: /\bopencode\b/gi, replacement: 'the client', why: '其它代理框架名' },
])

/**
 * 站点专属指纹：**不写进默认表**，由使用者在 config 里补。
 *
 * 理由很实际：每个人给自己的宿主装的人格 / 注入文案都不一样（有人装了某种人格包，
 * 有人装了另一套），把它硬编码进默认表等于替所有人决定他们的指纹长什么样。
 * 于是默认表只放**任何 DSH 都会留下**的痕迹，站点专属的那些走
 * `sanitize.extraRules`（config 里，或本机状态目录的 `sanitize.json`，见 README）。
 *
 * 这一项刻意留空，作为字段形状的示例保留。
 *
 * @type {ReadonlyArray<{pattern: RegExp, replacement: string, why: string}>}
 */
export const EXTRA_REWRITE_EXAMPLES = Object.freeze([
  // { pattern: /某个注入文案里的固定句子/gi, replacement: '', why: '人格注入文案' },
])

/**
 * 把 config 里的规则（字符串即可）编译成正则规则。
 *
 * YAML / JSON 里没法写 `RegExp`，所以配置项允许 `{ pattern: '…', flags: 'gi' }`。
 *
 * @param {ReadonlyArray<unknown>} entries
 * @returns {Array<{pattern: RegExp, replacement: string, why: string}>}
 */
export function compileRules(entries) {
  const out = []
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    const pattern = entry.pattern
    const flags = typeof entry.flags === 'string' ? entry.flags : 'gi'
    try {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), flags)
      out.push({
        pattern: regex,
        replacement: typeof entry.replacement === 'string' ? entry.replacement : '',
        why: typeof entry.why === 'string' && entry.why !== '' ? entry.why : `自定义指纹 (${String(pattern)})`,
      })
    } catch {
      /* 写错的正则跳过，不让一个配置项废掉整条车道 */
    }
  }
  return out
}

/**
 * 合规词脱敏表。都是「客户端合规模板」里出现、又被上游关键词匹配误伤的词。
 *
 * 只对 system / developer 消息生效，因此不会损坏用户真正要处理的内容。
 */
export const COMPLIANCE_WORDS = Object.freeze([
  'Claude', 'Anthropic', 'OpenAI', 'GPT', 'Gemini', 'Codex', 'Copilot', 'Cursor',
  'DoS', 'DDoS', 'exploit', 'credential', 'C2', 'malware', 'ransomware',
  'phishing', 'keylogger', 'rootkit', 'backdoor', 'jailbreak', 'prompt injection',
])

/** 把一个词拆开插入零宽空格：`Credential` -> `C\u200Bredential`。 */
export function desensitizeWord(word) {
  if (word.length < 2) return word
  const cut = Math.max(1, Math.floor(word.length / 2))
  return `${word.slice(0, cut)}${ZWSP}${word.slice(cut)}`
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 对一段文本做指纹改写。
 *
 * @param {string} text
 * @param {ReadonlyArray<{pattern: RegExp, replacement: string}>} rules
 * @returns {{text: string, hits: string[]}}
 */
export function scrubFingerprint(text, rules = FINGERPRINT_REWRITES) {
  let out = text
  const hits = []
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(out)) {
      hits.push(rule.why)
      rule.pattern.lastIndex = 0
      out = out.replace(rule.pattern, rule.replacement)
    }
  }
  return { text: out, hits: [...new Set(hits)] }
}

/**
 * 对一段文本做合规词脱敏。
 *
 * @param {string} text
 * @param {readonly string[]} words
 * @returns {{text: string, hits: string[]}}
 */
export function desensitizeText(text, words = COMPLIANCE_WORDS) {
  let out = text
  const hits = []
  for (const word of words) {
    // 词边界只在首尾是字母数字时才强加，避免 `C2` 之类误伤。
    const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi')
    if (pattern.test(out)) {
      hits.push(word)
      out = out.replace(pattern, match => desensitizeWord(match))
    }
  }
  return { text: out, hits }
}

/** 一个角色是否属于「只改这一侧」的集合。 */
function isSystemSide(role) {
  return role === 'system' || role === 'developer'
}

/**
 * 取一条消息的纯文本（块列表或裸字符串）。
 *
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && /** @type {any} */ (block).type === 'text' && typeof /** @type {any} */ (block).text === 'string') {
      parts.push(/** @type {any} */ (block).text)
    }
  }
  return parts.join('\n')
}

/**
 * 把一段文本写回内容块，保留非文本块（图片、工具调用）的相对顺序。
 *
 * @param {unknown} content
 * @param {string} text
 */
function withText(content, text) {
  if (typeof content === 'string') return text
  if (!Array.isArray(content)) return text
  let replaced = false
  const out = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && /** @type {any} */ (block).type === 'text') {
      if (!replaced) {
        out.push({ .../** @type {any} */ (block), text })
        replaced = true
      }
      continue
    }
    out.push(block)
  }
  if (!replaced) out.unshift({ type: 'text', text })
  return out
}

/**
 * 清洗一次出站调用的提示词。
 *
 * @param {object} input
 * @param {string|undefined} input.system - GenerateOptions.system
 * @param {ReadonlyArray<object>} input.messages - 已经投影成上游 wire 形状的消息数组
 * @param {object} [input.options] - `{ scrub: boolean, desensitize: boolean, scrubUser: boolean, words?: readonly string[], rules?: ReadonlyArray<{pattern: RegExp, replacement: string}>, extraRules?: ReadonlyArray<{pattern: string|RegExp, flags?: string, replacement?: string, why?: string}> }`
 * @returns {{system?: string, messages: ReadonlyArray<object>, report: {fingerprintHits: string[], desensitizedHits: string[]}}}
 */
export function sanitizeOutbound({ system, messages, options = {} }) {
  const scrub = options.scrub !== false
  const desensitize = options.desensitize !== false
  const scrubUser = options.scrubUser === true
  const rules = [
    // 站点专属指纹先跑：它们比通用规则更具体，先摘掉可以避免被通用规则改写后不再匹配。
    ...compileRules(options.extraRules),
    ...(options.rules ?? FINGERPRINT_REWRITES),
  ]
  const words = options.words ?? COMPLIANCE_WORDS
  const fingerprintHits = []
  const desensitizedHits = []

  const apply = (text, allowScrub, allowDesensitize) => {
    let out = text
    if (allowScrub && scrub) {
      const scrubbed = scrubFingerprint(out, rules)
      out = scrubbed.text
      fingerprintHits.push(...scrubbed.hits)
    }
    if (allowDesensitize && desensitize) {
      const desensitized = desensitizeText(out, words)
      out = desensitized.text
      desensitizedHits.push(...desensitized.hits)
    }
    return out
  }

  const nextSystem = typeof system === 'string' && system !== '' ? apply(system, true, true) : system

  const nextMessages = (messages ?? []).map(message => {
    const record = /** @type {Record<string, unknown>} */ (message)
    const role = typeof record.role === 'string' ? record.role : ''
    const systemSide = isSystemSide(role)
    if (!systemSide && !scrubUser) return message
    // tool 结果与 assistant 历史一律原样：改写它们等于篡改对话事实。
    if (role === 'tool' || role === 'assistant') return message
    const text = textOf(record.content)
    if (text === '') return message
    const next = apply(text, true, systemSide)
    if (next === text) return message
    return { ...record, content: withText(record.content, next) }
  })

  return {
    system: nextSystem,
    messages: nextMessages,
    report: {
      fingerprintHits: [...new Set(fingerprintHits)],
      desensitizedHits: [...new Set(desensitizedHits)],
    },
  }
}