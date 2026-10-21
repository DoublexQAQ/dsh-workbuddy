/**
 * DSH 消息词汇 -> OpenAI chat 协议（上游 `/v2/chat/completions` 本身就是这套）。
 *
 * 三件必须做对的事：
 *
 * 1. **工具配对修复**：任何「有调用没结果」或「有结果没调用」的历史，在上游都是
 *    400，而且会让**之后每一轮**都 400。持久会话里中断一次就会出现这种形状，
 *    所以发出去之前一律修掉。
 * 2. **两代会话格式都读**：DSH V4 把工具结果做成 `role:'tool'` 一等消息，
 *    V3 之前是 `user` 消息里裹 `tool-result` 块。只读一种就会把工具结果整批丢掉，
 *    模型看不到结果就会反复重发同一个调用。
 * 3. **推理不回放**：历史里的 reasoning 块不上行——上游不收，且回放会污染计费。
 *
 * @module src/messages.js
 */

/** 上游工具名字长度上限。 */
export const MAX_TOOL_NAME_LEN = 128

/** 纯文本块拼接。 */
function textOf(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 把 content 归一成块列表。 */
function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return { type: 'text', text: part }
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
          return { type: 'text', text: String(part.text ?? '') }
        }
        return part
      })
      .filter(block => block !== null && typeof block === 'object')
  }
  return []
}

function callIdOf(message) {
  const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
  return id === '' ? null : id
}

/** 一条消息携带的工具结果（两代格式）。 */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

/**
 * 丢掉没有答案的工具调用、以及没有调用的答案。
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {Array<object>}
 */
export function repairToolPairing(messages) {
  const list = messages ?? []
  const answered = new Set()
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId)
  }

  const keptCalls = new Set()
  const out = []
  for (const message of list) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      if (message.role === 'tool') {
        if (keptCalls.has(results[0].callId)) out.push(message)
        continue
      }
      const kept = new Set(results.filter(result => keptCalls.has(result.callId)).map(result => result.callId))
      const blocks = blocksOf(message.content)
      const rest = blocks.filter(block => block?.type !== 'tool-result'
        || kept.has(String(block.toolCallId ?? message.source?.callId ?? '')))
      if (rest.length === blocks.length) out.push(message)
      else if (rest.length > 0) out.push({ ...message, content: rest })
      continue
    }
    if (message?.role === 'tool') continue
    if (message?.role !== 'assistant') {
      out.push(message)
      continue
    }
    const blocks = blocksOf(message.content)
    const toolBlocks = blocks.filter(block => block?.type === 'tool-call')
    // 没有名字的调用不可执行；上游一旦看到它被「答复」过，就会永远留着这条毒记录。
    const calls = toolBlocks.filter(block => answered.has(String(block.id ?? '')) && String(block.name ?? '') !== '')
    for (const call of calls) keptCalls.add(String(call.id))
    if (calls.length === toolBlocks.length) {
      if (calls.length > 0 || blocks.some(block => block?.type === 'text' && block.text)) out.push(message)
      continue
    }
    if (calls.length === 0) {
      if (blocks.some(block => block?.type === 'text' && block.text)) {
        out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call') })
      }
      continue
    }
    out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call' || calls.includes(block)) })
  }
  return out
}

/**
 * 投影成上游消息数组。
 *
 * @param {ReadonlyArray<object>} messages - 已修好配对的历史
 * @param {{onImageDropped?: (reason: string) => void}} [hooks]
 * @returns {Array<object>}
 */
export function toChatMessages(messages, hooks = {}) {
  const out = []
  const followUp = []
  const dropImage = reason => hooks.onImageDropped?.(reason)
  const flushFollowUp = () => {
    if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
  }

  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length === 0) flushFollowUp()
    let blocks = blocksOf(message.content)

    if (results.length > 0) {
      for (const result of results) {
        const inner = []
        for (const block of result.content) {
          if (block?.type === 'image') dropImage('tool-result image')
          else if (block?.type === 'text' && block.text) inner.push({ type: 'text', text: block.text })
        }
        const text = textOf(result.content)
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: text || (inner.length > 0 ? '(see attached content)' : '(no output)'),
        })
      }
      blocks = blocks.filter(block => block?.type !== 'tool-result')
    }

    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') dropImage('user image')
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback) out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          calls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: typeof block.arguments === 'string' && block.arguments !== '' ? block.arguments : '{}',
            },
          })
        }
        if (!text && calls.length === 0) break
        const entry = { role: 'assistant', content: text || null }
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      case 'tool':
        break
      default:
        break
    }
  }
  flushFollowUp()
  return out
}

/**
 * DSH 的工具声明 -> 上游的 `tools`。
 *
 * @param {ReadonlyArray<object>} tools - `{name, description, parameters}`
 */
export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    const source = tool !== null && typeof tool === 'object' && typeof tool.function === 'object' && tool.function !== null
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (name === '') continue
    const parameters = source?.parameters !== null && typeof source?.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    list.push({
      type: 'function',
      function: {
        name: name.slice(0, MAX_TOOL_NAME_LEN),
        description: typeof source?.description === 'string' ? source.description : '',
        parameters,
      },
    })
  }
  return list
}

/** 这条消息里有没有需要视觉模型的内容。 */
export function needsVision(messages) {
  return (messages ?? []).some(message => blocksOf(message.content).some(block => block?.type === 'image'))
}