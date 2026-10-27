export interface ToolCallRequest {
  id: string;
  name: string;
  /** 模型给出的原始 JSON 字符串，可能非法，需要容错解析。 */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelReply {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage: ModelUsage;
  finishReason?: string;
}

/** 模型接入的抽象。真实 DeepSeek、录制、回放都实现它，Agent 循环不关心差异。 */
export interface ModelClient {
  readonly label: string;
  chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ModelReply>;
}

export const EMPTY_USAGE: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
