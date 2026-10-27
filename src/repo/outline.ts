export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'module'
  | 'heading'
  | 'other';

export interface SymbolEntry {
  kind: SymbolKind;
  name: string;
  /** 1 基行号，可直接用于引用。 */
  line: number;
  /** 该行原文，便于模型判断签名。 */
  signature: string;
}

interface Rule {
  regex: RegExp;
  kind: SymbolKind;
  /** 名字在第几个捕获组。 */
  nameGroup: number;
  /** 只认顶格（无缩进）的声明，避免把嵌套逻辑当结构。 */
  topLevelOnly?: boolean;
}

const TS_JS: Rule[] = [
  {
    regex:
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    kind: 'interface',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
    kind: 'type',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    kind: 'enum',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/,
    kind: 'constant',
    nameGroup: 1,
  },
];

const PYTHON: Rule[] = [
  { regex: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1, topLevelOnly: true },
  { regex: /^class\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 1, topLevelOnly: true },
];

const GO: Rule[] = [
  { regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1, topLevelOnly: true },
  { regex: /^type\s+([A-Za-z_]\w*)/, kind: 'type', nameGroup: 1, topLevelOnly: true },
];

const RUST: Rule[] = [
  {
    regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
    kind: 'type',
    nameGroup: 2,
  },
  { regex: /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module', nameGroup: 1 },
];

const JVM: Rule[] = [
  {
    regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(class|interface|enum|record)\s+([A-Za-z_]\w*)/,
    kind: 'class',
    nameGroup: 2,
  },
];

const MD: Rule[] = [{ regex: /^(#{1,6})\s+(.+)$/, kind: 'heading', nameGroup: 2 }];

const RULES: Record<string, Rule[]> = {
  '.ts': TS_JS,
  '.tsx': TS_JS,
  '.mts': TS_JS,
  '.cts': TS_JS,
  '.js': TS_JS,
  '.jsx': TS_JS,
  '.mjs': TS_JS,
  '.cjs': TS_JS,
  '.py': PYTHON,
  '.go': GO,
  '.rs': RUST,
  '.java': JVM,
  '.kt': JVM,
  '.scala': JVM,
  '.cs': JVM,
  '.swift': JVM,
  '.md': MD,
  '.markdown': MD,
};

export function supportsOutline(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext in RULES;
}

/**
 * 提取文件的顶层结构（函数、类、接口、标题）。
 * 这是基于正则的轻量大纲，不是完整 AST——够用来决定「该读哪个文件，
 * 从第几行开始读」，但不要指望它理解泛型或嵌套作用域。
 */
export function outlineText(path: string, text: string): SymbolEntry[] {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const rules = RULES[ext];
  if (!rules) return [];

  const symbols: SymbolEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (line.length > 400) continue;

    for (const rule of rules) {
      if (rule.topLevelOnly && /^\s/.test(line)) continue;
      const match = rule.regex.exec(line);
      if (!match) continue;
      const name = match[rule.nameGroup];
      if (!name) continue;
      symbols.push({
        kind: rule.kind,
        name: ext === '.md' || ext === '.markdown' ? name.trim() : name,
        line: index + 1,
        signature: line.trim().slice(0, 160),
      });
      break;
    }
  }

  return symbols;
}
