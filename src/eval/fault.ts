import type { ModelClient, ModelReply } from '../model/types.js';
import { extractCitations } from '../verify/citations.js';

/**
 * 故障注入：只在评测里用，**不代表真实模型表现**。
 *
 * 背景：在 22 道基准题上关闭自校正时引用通过率已经接近 100%，自校正一次都没被触发。
 * 也就是说「机制有效」这件事无法靠自然失败来证明——那就反过来验证闭环：
 * 人为把第一份回答里的行号改错，看它能不能在给定回合内把引用修回真实位置。
 *
 * 这不是造假，因为注入的故障是**明确标注**的，衡量的也不是模型水平，
 * 而是「校验 → 回灌 → 重查 → 重答」这条闭环本身是否真的闭得上。
 */

export interface FaultOptions {
  /** 最多改错几条引用，默认 1。 */
  maxFaults?: number;
  /** 行号偏移量，默认 +1000——足以让任何文件的行号越界。 */
  shift?: number;
}

function corruptText(text: string, maxFaults: number, shift: number): { text: string; injected: number } {
  const hits = extractCitations(text).slice(0, maxFaults);
  let out = text;
  let injected = 0;

  for (const hit of hits) {
    const start = hit.startLine + shift;
    const replacement =
      hit.endLine === hit.startLine ? `${hit.path}:${start}` : `${hit.path}:${start}-${hit.endLine + shift}`;
    if (!out.includes(hit.raw)) continue;
    out = out.replace(hit.raw, replacement);
    injected += 1;
  }

  return { text: out, injected };
}

export interface FaultClient extends ModelClient {
  /** 实际改错的引用条数。 */
  readonly injected: () => number;
}

/**
 * 包一层模型客户端：把**第一次最终回答**里的引用改错，之后的回答原样放行。
 * 这样 Agent 的校验器一定会报错，从而触发自校正路径。
 */
export function withCitationFaults(client: ModelClient, options: FaultOptions = {}): FaultClient {
  const maxFaults = Math.max(1, options.maxFaults ?? 1);
  const shift = options.shift ?? 1000;
  let armed = true;
  let injected = 0;

  return {
    label: `${client.label} + 故障注入`,
    injected: () => injected,
    async chat(messages, tools): Promise<ModelReply> {
      const reply = await client.chat(messages, tools);
      if (!armed || reply.toolCalls.length > 0 || !reply.content) return reply;

      armed = false;
      const { text, injected: count } = corruptText(reply.content, maxFaults, shift);
      injected = count;
      return { ...reply, content: text };
    },
  };
}