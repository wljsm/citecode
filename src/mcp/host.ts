import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSchema } from '../model/types.js';

/** 一个 MCP Server 的启动描述（stdio 传输）。 */
export interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** 挂载到 Host 上的工具，名称带 Server 前缀以避免多 Server 冲突。 */
export interface HostedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
  originalName: string;
}

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
  durationMs: number;
}

const MAX_FUNCTION_NAME = 64;

/** OpenAI / DeepSeek 的函数名只允许字母数字下划线，这里做一次兜底规范化。 */
export function namespacedToolName(server: string, tool: string): string {
  const raw = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return raw.slice(0, MAX_FUNCTION_NAME);
}

function currentEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') base[key] = value;
  }
  return { ...base, ...extra };
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return stringify(content);
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      parts.push(stringify(item));
      continue;
    }
    const record = item as { type?: string; text?: string; mimeType?: string; resource?: { text?: string } };
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'resource' && typeof record.resource?.text === 'string') {
      parts.push(record.resource.text);
    } else if (record.type === 'image') {
      parts.push(`[图片内容已省略：${record.mimeType ?? 'unknown'}]`);
    } else {
      parts.push(stringify(item));
    }
  }
  return parts.join('\n');
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * MCP Host：拉起若干 stdio Server，聚合工具列表并路由调用。
 * 对外暴露的 `server__tool` 名字只用于模型选择，真正下发的仍是原始工具名。
 */
export class McpHost {
  private constructor(
    private readonly clients: Map<string, Client>,
    private readonly tools: HostedTool[],
    private readonly toolIndex: Map<string, HostedTool>,
  ) {}

  static async connect(specs: ServerSpec[]): Promise<McpHost> {
    const clients = new Map<string, Client>();
    const tools: HostedTool[] = [];
    const toolIndex = new Map<string, HostedTool>();

    try {
      for (const spec of specs) {
        const transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: currentEnv(spec.env),
          cwd: spec.cwd,
          stderr: 'pipe',
        });
        const client = new Client({ name: `citecode-host/${spec.name}`, version: '0.1.0' });
        await client.connect(transport);
        clients.set(spec.name, client);

        const listed = await client.listTools();
        for (const tool of listed.tools) {
          const hosted: HostedTool = {
            name: namespacedToolName(spec.name, tool.name),
            description: tool.description ?? `${spec.name} 提供的 ${tool.name} 工具`,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            server: spec.name,
            originalName: tool.name,
          };
          if (toolIndex.has(hosted.name)) {
            throw new Error(`工具名冲突：${hosted.name}，请检查 Server 命名`);
          }
          toolIndex.set(hosted.name, hosted);
          tools.push(hosted);
        }
      }
    } catch (error) {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      throw error;
    }

    return new McpHost(clients, tools, toolIndex);
  }

  listTools(): HostedTool[] {
    return [...this.tools];
  }

  /** 转成模型侧的 function calling 描述。 */
  toModelTools(): ToolSchema[] {
    return this.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const started = Date.now();
    const tool = this.toolIndex.get(name);
    if (!tool) {
      return {
        text: `未知工具：${name}。可用工具：${[...this.toolIndex.keys()].join(', ')}`,
        isError: true,
        durationMs: 0,
      };
    }
    const client = this.clients.get(tool.server);
    if (!client) {
      return { text: `工具所属 Server 未连接：${tool.server}`, isError: true, durationMs: 0 };
    }

    try {
      const result = (await client.callTool({ name: tool.originalName, arguments: args })) as {
        content?: unknown;
        isError?: boolean;
      };
      return {
        text: contentToText(result.content),
        isError: result.isError === true,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        text: `工具执行异常：${(error as Error).message}`,
        isError: true,
        durationMs: Date.now() - started,
      };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }
}
