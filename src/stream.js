/**
 * 上游 SSE -> DSH `StreamChunk` 投影。
 *
 * DSH 的契约是一个**扁平带索引的区块协议**：每个块先 `block-start`，再由 delta 喂，
 * 最后用携带装配结果的 `block-end` 收尾；索引进场顺序分配。上游（标准 OpenAI
 * chat 协议）本来就是 delta 流，所以这一层是纯投影，不做聚合、不做缓冲——
 * 唯一例外是 DSML 控制标记的尾巴（见下）。
 *
 * 计数遵循 DSH 的「互斥计数」规则：`inputTokens` 是**未命中缓存**的输入，
 * 因此要把 `prompt_tokens` 里的缓存命中减回去。
 *
 * @module src/stream.js
 */

import crypto from 'node:crypto'

/**
 * DeepSeek v4 家族偶尔把内部 DSML 控制标记泄进可见文本（推理→动作交界处）。
 * 逐段清洗：可能还没写完的尾巴先扣住，等下一段确认；流结束时再决定吐出还是丢弃。
 */
const DSML_OPENING = '<｜DSML｜'
const DSML_TAG = /<｜DSML｜[^>]*>/g

function createDsmlScrubber() {
  let held = ''
  return {
    push(delta) {
      let text = held + delta
      held = ''
      const cut = text.lastIndexOf('<')
      if (cut !== -1) {
        const tail = text.slice(cut)
        if (DSML_OPENING.startsWith(tail) || (tail.startsWith(DSML_OPENING) && !tail.includes('>'))) {
          held = tail
          text = text.slice(0, cut)
        }
      }
      return text.replace(DSML_TAG, '')
    },
    flush() {
      const out = held
      held = ''
      if (out === '' || DSML_OPENING.startsWith(out) || (out.startsWith(DSML_OPENING) && !out.includes('>'))) return ''
      return out.replace(DSML_TAG, '')
    },
  }
}

/** 上游没给调用 id 时补一个稳定代用 id（否则下一轮配对会被丢掉）。 */
function mintToolCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

/** 上游 thinking 可能用的几种拼写，按偏好顺序读第一个非空的。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking']

function reasoningOf(delta) {
  for (const field of REASONING_FIELDS) {
    const value = delta[field]
    if (typeof value === 'string' && value !== '') return value
  }
  if (Array.isArray(delta.reasoning_details)) {
    let text = ''
    for (const part of delta.reasoning_details) if (typeof part?.text === 'string') text += part.text
    if (text !== '') return text
  }
  return undefined
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 上游 usage -> DSH 的互斥 TokenUsage。
 *
 * `prompt_tokens_details` 是可选的，而 DSH 的持久会话日志拒收非有限数：
 * 缺缓存计数必须先补 0 再相减，否则 `inputTokens` 会变成 NaN。
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = number(usage.completion_tokens ?? usage.output_tokens)
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const cacheWrite = number(usage.prompt_tokens_details?.cache_write_tokens)
  const reasoning = number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = { inputTokens: Math.max(0, (prompt ?? 0) - cached), outputTokens: completion ?? 0 }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  if (reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/** 上游 finish token -> DSH 的结束原因。 */
export function finishReason(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** 块装配器：把 delta 流摊成 DSH 的扁平区块。 */
class BlockSink {
  /**
   * @param {(chunk: object) => void} emit
   * @param {number} startIndex
   * @param {() => void} [onProgress]
   */
  constructor(emit, startIndex, onProgress) {
    this.emit = emit
    this.next = startIndex
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    /** @type {Map<string, {index: number, kind: string, text: string, id?: string, name?: string, args?: string}>} */
    this.open = new Map()
    this.sawText = false
    this.sawReasoning = false
    this.sawToolCall = false
    this.brokenToolCall = false
    this.lastToolKey = undefined
    this.dsml = createDsmlScrubber()
  }

  /** 上游 `tool_calls[].index` 是累积键；没有 index 的用调用 id 区分。 */
  toolKey(call) {
    if (call.index !== undefined && call.index !== null) {
      this.lastToolKey = `c${call.index}`
      return this.lastToolKey
    }
    if (typeof call.id === 'string' && call.id !== '') {
      for (const [key, block] of this.open) {
        if (block.kind === 'tool-call' && block.id === call.id) {
          this.lastToolKey = key
          return key
        }
      }
      this.lastToolKey = `cid:${call.id}`
      return this.lastToolKey
    }
    return this.lastToolKey ?? 'c0'
  }

  slot(key, kind) {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    const block = { index: this.next++, kind, text: '', args: '', id: kind === 'tool-call' ? mintToolCallId() : '', name: '' }
    this.open.set(key, block)
    this.emit({
      type: 'block-start',
      index: block.index,
      blockType: kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text',
    })
    return block
  }

  text(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    const scrubbed = this.dsml.push(delta)
    if (scrubbed === '') return
    this.sawText = true
    const block = this.slot(key, 'text')
    block.text += scrubbed
    this.emit({ type: 'text-delta', index: block.index, text: scrubbed })
  }

  reasoning(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawReasoning = true
    const block = this.slot(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  toolStart(key, id, name) {
    const block = this.slot(key, 'tool-call')
    const priorId = block.id
    const priorName = block.name
    if (id) block.id = id
    if (name) block.name = name
    if (typeof block.name === 'string' && block.name.trim() !== '' && (block.name !== priorName || block.id !== priorId)) this.onProgress()
  }

  toolArgs(key, delta) {
    this.sawToolCall = true
    if (!delta) return
    const block = this.slot(key, 'tool-call')
    block.args += delta
    const name = typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}
    // DSH 会用无损 JSON 快照重读每个块，它拒收值为 undefined 的字段：未知名字必须省略。
    this.emit({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', ...name, argumentsDelta: delta })
  }

  closeAll() {
    const spill = this.dsml.flush()
    let spilled = false
    for (const block of this.open.values()) {
      if (block.kind === 'text' && !spilled && spill !== '') {
        spilled = true
        block.text += spill
        this.emit({ type: 'text-delta', index: block.index, text: spill })
      }
      if (block.kind === 'text' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning' && block.text !== '') {
        this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      } else if (block.kind === 'tool-call') {
        // 参数解析不出来的调用不可执行；上游即使被输出上限截断也可能报 tool_calls，
        // 所以 finish token 不足以信任，改判 max-tokens 让 DSH 剪掉这个调用。
        try {
          JSON.parse(block.args === '' ? '{}' : block.args)
        } catch {
          this.brokenToolCall = true
        }
        if (typeof block.name !== 'string' || block.name === '') this.brokenToolCall = true
        this.emit({
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args },
        })
      }
    }
    this.open.clear()
  }
}

/**
 * 读一条 chat 协议的 SSE 流，逐块产出 DSH 的 `StreamChunk`。
 *
 * @param {AsyncIterable<string>} lines - 已切好的 `data:` 载荷
 * @param {object} [options]
 * @param {number} [options.startIndex]
 * @param {() => void} [options.onProgress]
 * @param {(responseId: string) => void} [options.onResponseId] - 记下上游响应 id 以延续 previous_response_id
 * @returns {AsyncGenerator<object, {usage?: object, finish?: string, sawFinish: boolean, sawText: boolean, sawReasoning: boolean, sawToolCall: boolean, brokenToolCall: boolean, responseId?: string, nextIndex: number}>}
 */
export async function* readChatStream(lines, options = {}) {
  const outbox = []
  const startIndex = Number.isSafeInteger(options.startIndex) && options.startIndex >= 0 ? options.startIndex : 0
  const sink = new BlockSink(chunk => outbox.push(chunk), startIndex, options.onProgress)
  const state = {
    usage: undefined,
    credit: undefined,
    finish: undefined,
    sawFinish: false,
    sawText: false,
    sawReasoning: false,
    sawToolCall: false,
    responseId: undefined,
  }

  const onFinish = (usage, kind, token) => {
    if (kind === 'usage' && usage !== undefined) state.usage = usage
    if (kind !== 'finish') return
    state.sawFinish = true
    // 不带原因的终止帧只标记结束，不能擦掉此前状态帧给的 finish token。
    if (token !== undefined) state.finish = token
  }

  for await (const raw of lines) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text === '[DONE]') {
      state.sawFinish = true
      break
    }
    if (!text.startsWith('{')) continue
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      continue
    }
    if (typeof payload.id === 'string' && payload.id !== '') {
      state.responseId = payload.id
      options.onResponseId?.(payload.id)
    }
    if (payload.type === 'error' || payload.error) {
      const error = new Error(typeof payload.error?.message === 'string' ? payload.error.message : 'upstream error')
      error.upstream = payload
      error.code = 'SERVER'
      throw error
    }
    if (payload.usage) {
      onFinish(mapUsage(payload.usage), 'usage')
      const credit = Number(payload.usage.credit ?? payload.usage.credits)
      if (Number.isFinite(credit)) state.credit = credit
      options.onUsage?.(payload.usage)
    }
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = reasoningOf(delta)
      if (reasoning !== undefined) sink.reasoning('r', reasoning)
      if (typeof delta.content === 'string') sink.text('t', delta.content)
      for (const call of delta.tool_calls ?? []) {
        const key = sink.toolKey(call)
        const name = call.function?.name
        if (typeof name === 'string' && name !== '') sink.toolStart(key, call.id ?? '', name)
        else if (call.id) sink.toolStart(key, call.id, '')
        if (call.function?.arguments) sink.toolArgs(key, call.function.arguments)
      }
      if (choice.finish_reason) onFinish(undefined, 'finish', choice.finish_reason)
    }
    state.sawText = sink.sawText
    state.sawReasoning = sink.sawReasoning
    state.sawToolCall = sink.sawToolCall
    while (outbox.length > 0) yield outbox.shift()
  }

  sink.closeAll()
  state.sawText = sink.sawText
  state.sawReasoning = sink.sawReasoning
  state.sawToolCall = sink.sawToolCall
  state.brokenToolCall = sink.brokenToolCall
  while (outbox.length > 0) yield outbox.shift()

  if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
  const token = state.brokenToolCall && state.finish === 'tool_calls' ? 'length' : state.finish
  yield { type: 'finish', reason: finishReason(token) }

  return {
    usage: state.usage,
    finish: state.finish,
    sawFinish: state.sawFinish,
    sawText: state.sawText,
    sawReasoning: state.sawReasoning,
    sawToolCall: state.sawToolCall,
    brokenToolCall: sink.brokenToolCall,
    responseId: state.responseId,
    nextIndex: sink.next,
    /**
     * 这一次调用**真实扣掉的积分**（上游在末帧 `usage.credit` 里给，免费模型是 0）。
     * 这是实测值而不是「倍率 × token」的估算，所以它是唯一值得显示给用户的数字。
     */
    credit: state.credit,
  }
}