import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelReply, ModelUsage, ToolCallRequest } from './types.js';

/**
 * 录制/回放：把一次问答的全部模型响应写成 JSONL（cassette）。
 * 回放时完全不碰网络，因此 CI 与离线演示都能复现同一条执行轨迹。
 */
export interface CassetteRecord {
  turn: number;
  model: string;
  /** 记录请求规模，回放时用来提示 cassette 是否已过期。 */
  requestMessages: number;
  reply: {
    content: string | null;
    toolCalls: ToolCallRequest[];
    usage: ModelUsage;
    finishReason?: string;
  };
}

export function parseCassette(text: string): CassetteRecord[] {
  const records: CassetteRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`cassette 第 ${index + 1} 行不是合法 JSON`);
    }
    const record = parsed as CassetteRecord;
    if (typeof record?.turn !== 'number' || !record.reply) {
      throw new Error(`cassette 第 ${index + 1} 行缺少 turn/reply 字段`);
    }
    records.push(record);
  }
  return records;
}

export class CassetteReplay {
  private cursor = 0;

  constructor(
    private readonly records: CassetteRecord[],
    readonly source: string,
  ) {}

  get size(): number {
    return this.records.length;
  }

  next(requestMessages: number): ModelReply {
    const record = this.records[this.cursor];
    if (!record) {
      throw new Error(
        `回放失败：cassette 只有 ${this.records.length} 条记录，但 Agent 需要第 ${this.cursor + 1} 轮。请重新录制。`,
      );
    }
    if (record.requestMessages !== requestMessages) {
      throw new Error(
        `回放失败：第 ${record.turn + 1} 轮请求了 ${requestMessages} 条消息，而录制时是 ${record.requestMessages} 条。` +
          '通常是工具输出发生变化，请重新录制。',
      );
    }
    this.cursor += 1;
    return {
      content: record.reply.content,
      toolCalls: record.reply.toolCalls ?? [],
      usage: record.reply.usage,
      finishReason: record.reply.finishReason,
    };
  }
}

export class CassetteRecorder {
  private readonly records: CassetteRecord[] = [];

  record(turn: number, model: string, requestMessages: number, reply: ModelReply): void {
    this.records.push({
      turn,
      model,
      requestMessages,
      reply: {
        content: reply.content,
        toolCalls: reply.toolCalls,
        usage: reply.usage,
        ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
      },
    });
  }

  get count(): number {
    return this.records.length;
  }

  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const body = this.records.map((record) => JSON.stringify(record)).join('\n');
    writeFileSync(file, `${body}\n`, 'utf8');
  }
}

export function loadCassette(file: string): CassetteReplay {
  const text = readFileSync(file, 'utf8');
  return new CassetteReplay(parseCassette(text), file);
}
