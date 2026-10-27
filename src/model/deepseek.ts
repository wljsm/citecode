import OpenAI from 'openai';
import { basename } from 'node:path';
import type { Config } from '../config.js';
import { CassetteReplay, CassetteRecorder } from './cassette.js';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type ModelClient,
  type ModelReply,
  type ToolCallRequest,
  type ToolSchema,
} from './types.js';

export interface ModelOptions {
  /** 提供后进入回放模式：不联网，逐条吐出录制好的响应。 */
  replay?: CassetteReplay;
  /** 提供后进入录制模式：每次真实调用都写一份记录。 */
  recorder?: CassetteRecorder;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 把 SDK 异常翻译成一句能直接给用户看的话。 */
export function explainModelError(error: unknown, baseUrl: string, model: string): string {
  const err = error as { status?: number; message?: string; error?: { message?: string } };
  const detail = err?.error?.message ?? err?.message ?? String(error);
  switch (err?.status) {
    case 401:
      return `鉴权失败（401）：API Key 无效或已过期。请检查 .env 中的 DEEPSEEK_API_KEY。原始信息：${detail}`;
    case 402:
      return `余额不足（402）：${baseUrl} 账户需要充值。原始信息：${detail}`;
    case 404:
      return `模型不存在（404）：${model} 在该服务上不可用，请检查 CITECODE_MODEL。原始信息：${detail}`;
    case 429:
      return `请求过于频繁（429）：稍后重试或降低并发。原始信息：${detail}`;
    case 400:
      return `请求被拒绝（400）：${detail}`;
    case 500:
    case 502:
    case 503:
      return `模型服务暂时不可用（${err.status}）：${detail}`;
    default:
      return `调用模型失败：${detail}`;
  }
}

function toOpenAiMessages(
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
      return { role: 'assistant', content: message.content ?? '' };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.tool_call_id ?? '', content: message.content ?? '' };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

function toReply(completion: OpenAI.Chat.Completions.ChatCompletion): ModelReply {
  const choice = completion.choices[0];
  const message = choice?.message;
  const toolCalls: ToolCallRequest[] = [];
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  const usage = completion.usage;
  return {
    content: message?.content ?? null,
    toolCalls,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
      : EMPTY_USAGE,
    finishReason: choice?.finish_reason ?? undefined,
  };
}

/**
 * 创建模型客户端。DeepSeek 走 OpenAI 兼容协议，因此直接用官方 openai SDK。
 * 录制模式会把每一轮真实响应落盘，供之后的回放与评测复用。
 */
export function createModelClient(config: Config, options: ModelOptions = {}): ModelClient {
  const replay = options.replay;
  const recorder = options.recorder;
  const label = replay ? `replay(${basename(replay.source)})` : `${config.model}@${hostOf(config.baseUrl)}`;

  let client: OpenAI | null = null;
  let turn = 0;

  const ensureClient = (): OpenAI => {
    if (!config.apiKey) {
      throw new Error(
        '缺少模型密钥：请把 .env.example 复制为 .env 并填写 DEEPSEEK_API_KEY，' +
          '或使用 --replay 回放模式（无需密钥）。',
      );
    }
    client ??= new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: 180_000,
      maxRetries: 2,
    });
    return client;
  };

  return {
    label,

    async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ModelReply> {
      if (replay) {
        const reply = replay.next(messages.length);
        turn += 1;
        return reply;
      }

      const sdk = ensureClient();
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await sdk.chat.completions.create({
          model: config.model,
          messages: toOpenAiMessages(messages),
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        });
      } catch (error) {
        throw new Error(explainModelError(error, config.baseUrl, config.model));
      }

      const reply = toReply(completion);
      recorder?.record(turn, config.model, messages.length, reply);
      turn += 1;
      return reply;
    },
  };
}
