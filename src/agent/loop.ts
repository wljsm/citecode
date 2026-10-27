import type { McpHost } from '../mcp/host.js';
import {
  addUsage,
  EMPTY_USAGE,
  type ChatMessage,
  type ModelClient,
  type ModelUsage,
} from '../model/types.js';
import { verifyCitations, type CitationReport } from '../verify/citations.js';
import { BUDGET_EXHAUSTED_PROMPT, buildMessages } from './prompts.js';
import { buildRepairPrompt, failedCitations } from './repair.js';

export type AgentEvent =
  | { type: 'round'; round: number }
  | { type: 'assistant'; round: number; content: string; toolCallCount: number }
  | { type: 'tool'; round: number; name: string; ok: boolean; durationMs: number; preview: string }
  | { type: 'verify'; round: number; verified: number; total: number }
  | { type: 'repair'; round: number; attempt: number; failed: number; total: number }
  | { type: 'hint'; message: string };

export interface ToolCallLog {
  round: number;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  resultChars: number;
  error?: string;
}

export interface AgentRunOptions {
  question: string;
  repoRoot: string;
  repoLabel?: string;
  fileCount?: number;
  maxRounds?: number;
  /**
   * 引用自校正的最大回合数。0 表示关闭——消融实验就是靠这个开关做对照的。
   */
  maxRepairs?: number;
  client: ModelClient;
  host: McpHost;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  answer: string;
  messages: ChatMessage[];
  toolCalls: ToolCallLog[];
  usage: ModelUsage;
  rounds: number;
  stopReason: 'final' | 'budget' | 'error';
  error?: string;
  /** 最终回答的引用校验结果。 */
  citations: CitationReport;
  /** 第一次给出完整回答时的校验结果（修正之前），用于衡量修正带来的提升。 */
  initialCitations: CitationReport;
  /** 实际发生的修正回合数。 */
  repairs: number;
}

function emptyReport(): CitationReport {
  return { citations: [], total: 0, verified: 0, ratio: 0, files: [] };
}

/** 校验失败不应该让整轮任务失败：仓库不可读时退化为「无引用」。 */
function safeVerify(root: string, answer: string): CitationReport {
  try {
    return verifyCitations(root, answer);
  } catch {
    return emptyReport();
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function preview(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 180 ? `${single.slice(0, 180)}…` : single;
}

/**
 * Agent 主循环：模型 ⇄ 工具，直到模型给出最终回答或预算耗尽。
 *
 * 与 v0.1 的区别：模型给出最终回答后不直接返回，而是回读仓库校验引用；
 * 有没通过的引用就把失败清单回灌，让模型用工具重新确认后重答（最多 maxRepairs 次）。
 * 超过轮次预算时不粗暴截断，而是强制模型基于已有证据收尾。
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { client, host } = options;
  const maxRounds = Math.max(1, options.maxRounds ?? 24);
  const maxRepairs = Math.max(0, options.maxRepairs ?? 2);
  const emit = options.onEvent ?? (() => undefined);

  const tools = host.toModelTools();
  const messages = buildMessages(
    options.question,
    options.repoLabel ?? options.repoRoot,
    options.fileCount ?? 0,
  );

  const toolCalls: ToolCallLog[] = [];
  let usage: ModelUsage = EMPTY_USAGE;
  let rounds = 0;
  let repairs = 0;
  let initialCitations: CitationReport | null = null;

  try {
    for (;;) {
      if (rounds >= maxRounds) {
        emit({ type: 'hint', message: `预算 ${maxRounds} 轮已用尽，正在整理阶段性回答` });
        messages.push({ role: 'user', content: BUDGET_EXHAUSTED_PROMPT });
        const closing = await client.chat(messages, []);
        usage = addUsage(usage, closing.usage);
        const answer = closing.content?.trim() || '（模型在预算耗尽后没有给出回答）';
        messages.push({ role: 'assistant', content: closing.content ?? '' });
        const citations = safeVerify(options.repoRoot, answer);
        emit({ type: 'verify', round: rounds, verified: citations.verified, total: citations.total });
        return {
          answer,
          messages,
          toolCalls,
          usage,
          rounds,
          stopReason: 'budget',
          citations,
          initialCitations: initialCitations ?? citations,
          repairs,
        };
      }

      rounds += 1;
      emit({ type: 'round', round: rounds });

      const reply = await client.chat(messages, tools);
      usage = addUsage(usage, reply.usage);

      messages.push({
        role: 'assistant',
        content: reply.content,
        ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
      });
      emit({
        type: 'assistant',
        round: rounds,
        content: reply.content ?? '',
        toolCallCount: reply.toolCalls.length,
      });

      if (reply.toolCalls.length === 0) {
        const answer = (reply.content ?? '').trim();
        const citations = safeVerify(options.repoRoot, answer);
        initialCitations ??= citations;
        emit({ type: 'verify', round: rounds, verified: citations.verified, total: citations.total });

        const repairPrompt = buildRepairPrompt(citations, answer);
        if (repairPrompt !== null && repairs < maxRepairs) {
          repairs += 1;
          emit({
            type: 'repair',
            round: rounds,
            attempt: repairs,
            failed: failedCitations(citations).length,
            total: citations.total,
          });
          messages.push({ role: 'user', content: repairPrompt });
          continue;
        }

        return {
          answer,
          messages,
          toolCalls,
          usage,
          rounds,
          stopReason: 'final',
          citations,
          initialCitations,
          repairs,
        };
      }

      for (const call of reply.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = parseArguments(call.arguments);
        } catch (error) {
          const message = `工具参数不是合法 JSON：${(error as Error).message}。收到的原始参数：${call.arguments.slice(0, 200)}`;
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: message });
          toolCalls.push({
            round: rounds,
            name: call.name,
            arguments: {},
            ok: false,
            durationMs: 0,
            resultChars: message.length,
            error: message,
          });
          emit({ type: 'tool', round: rounds, name: call.name, ok: false, durationMs: 0, preview: message });
          continue;
        }

        const outcome = await host.call(call.name, args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: outcome.text,
        });
        toolCalls.push({
          round: rounds,
          name: call.name,
          arguments: args,
          ok: !outcome.isError,
          durationMs: outcome.durationMs,
          resultChars: outcome.text.length,
          ...(outcome.isError ? { error: outcome.text.slice(0, 300) } : {}),
        });
        emit({
          type: 'tool',
          round: rounds,
          name: call.name,
          ok: !outcome.isError,
          durationMs: outcome.durationMs,
          preview: preview(outcome.text),
        });
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    const failed = emptyReport();
    return {
      answer: `执行中断：${message}`,
      messages,
      toolCalls,
      usage,
      rounds,
      stopReason: 'error',
      error: message,
      citations: failed,
      initialCitations: initialCitations ?? failed,
      repairs,
    };
  }
}