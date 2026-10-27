import type { AgentEvent } from '../agent/loop.js';

/** Web 端展示一次运行所需的全部数据，live 与 snapshot 两种模式共用。 */
export interface WebCitation {
  raw: string;
  path: string;
  startLine: number;
  endLine: number;
  status: 'verified' | 'missing_file' | 'out_of_range' | 'empty';
  detail?: string;
  snippet?: string;
}

export interface SourceLine {
  n: number;
  text: string;
}

/** 右栏展示的源码片段：带行号，供点击引用时定位。 */
export interface SourceView {
  path: string;
  start: number;
  end: number;
  lines: SourceLine[];
  error?: string;
}

export interface WebRunStats {
  rounds: number;
  toolCalls: number;
  tokens: number;
  stopReason: string;
  repairs: number;
  durationMs: number;
}

export interface WebRun {
  question: string;
  caseId?: string;
  repoLabel: string;
  fileCount: number;
  model: string;
  mode: 'live' | 'replay';
  events: AgentEvent[];
  answer: string;
  citations: {
    total: number;
    verified: number;
    ratio: number;
    items: WebCitation[];
  };
  stats: WebRunStats;
  /** key 是引用原文，例如 `src/app.ts:27`。 */
  sources: Record<string, SourceView>;
}

export interface WebPreset {
  id: string;
  question: string;
}