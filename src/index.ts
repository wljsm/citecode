/**
 * CiteCode 的公共 API。
 * CLI 是最常见入口，但下面这些导出也可以被其他 Node 程序直接复用。
 */
export { loadConfig, loadEnvFile, parseEnv, type Config } from './config.js';
export { McpHost, namespacedToolName, type HostedTool, type ServerSpec } from './mcp/host.js';
export { createModelClient, explainModelError, type ModelOptions } from './model/deepseek.js';
export { CassetteRecorder, CassetteReplay, loadCassette, parseCassette, type CassetteRecord } from './model/cassette.js';
export type { ChatMessage, ModelClient, ModelReply, ModelUsage, ToolSchema } from './model/types.js';
export { runAgent, type AgentEvent, type AgentRunOptions, type AgentRunResult, type ToolCallLog } from './agent/loop.js';
export { BUDGET_EXHAUSTED_PROMPT, SYSTEM_PROMPT, buildUserPrompt } from './agent/prompts.js';
export { buildRepairPrompt, failedCitations, needsRepair } from './agent/repair.js';
export {
  extractCitations,
  renderCitationReport,
  verifyCitations,
  type CitationCheck,
  type CitationReport,
  type CitationStatus,
} from './verify/citations.js';
export { RepoSandbox, RepoAccessError, type RepoErrorCode } from './repo/sandbox.js';
export { walkFiles, type FileEntry, type WalkOptions, type WalkResult } from './repo/walk.js';
export { searchCode, globToRegExp, type SearchHit, type SearchOptions, type SearchResult } from './repo/search.js';
export { outlineText, supportsOutline, type SymbolEntry, type SymbolKind } from './repo/outline.js';
export {
  runSuite,
  renderCaseLine,
  renderSummary,
  type CaseResult,
  type EvalDeps,
  type GoldenCase,
  type GoldenSuite,
  type SuiteSummary,
} from './eval/runner.js';
export {
  DEFAULT_ABLATION_CONFIGS,
  renderAblation,
  runAblation,
  type AblationConfig,
  type AblationReport,
  type AblationRun,
} from './eval/ablation.js';
export { withCitationFaults, type FaultClient, type FaultOptions } from './eval/fault.js';
export { renderPage, type PageOptions } from './web/page.js';
export { startWebServer, exportSnapshot, type WebDeps, type ServerHandle } from './web/server.js';
export { sourceView } from './web/source.js';
export type { SourceView, WebCitation, WebPreset, WebRun, WebRunStats } from './web/types.js';
