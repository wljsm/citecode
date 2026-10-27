import type { WebPreset, WebRun } from './types.js';

export interface PageOptions {
  model: string;
  mode: 'live' | 'replay';
  repoLabel: string;
  fileCount: number;
  tools: string[];
  presets: WebPreset[];
  /** 有值则渲染自包含快照（不联网、不发请求）。 */
  snapshot?: WebRun;
}

/** JSON 内联进 <script> 时必须转义 `<`，否则答案里的 `</script>` 会把页面截断。 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
}

const STYLE = `
:root {
  --bg: #0F172A;
  --card: #1B2336;
  --card-2: #222C44;
  --fg: #F8FAFC;
  --muted: #94A3B8;
  --accent: #22C55E;
  --danger: #EF4444;
  --warn: #F59E0B;
  --line: rgba(148, 163, 184, 0.16);
  --line-strong: rgba(148, 163, 184, 0.32);
  --mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: Inter, "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --r: 16px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background:
    radial-gradient(1100px 520px at 12% -10%, rgba(34, 197, 94, 0.10), transparent 60%),
    radial-gradient(900px 460px at 88% 0%, rgba(59, 130, 246, 0.10), transparent 62%),
    var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.top {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line);
  background: rgba(15, 23, 42, 0.82);
  backdrop-filter: blur(14px);
}
.brand { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.brand b { letter-spacing: 0.2px; }
.logo { color: var(--accent); font-size: 18px; line-height: 1; }
.muted { color: var(--muted); }
.meta { display: flex; gap: 8px; align-items: center; }
.pill {
  padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(34, 197, 94, 0.08);
  color: var(--fg); font-size: 12px; font-family: var(--mono);
}
.pill.plain { background: rgba(148, 163, 184, 0.08); }
.layout {
  display: grid; grid-template-columns: minmax(0, 1fr) 420px;
  gap: 16px; padding: 16px 24px 28px; max-width: 1420px; margin: 0 auto;
  align-items: start;
}
@media (max-width: 1080px) { .layout { grid-template-columns: minmax(0, 1fr); } }
.panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 16px;
}
.side { position: sticky; top: 74px; max-height: calc(100vh - 92px); display: flex; flex-direction: column; }
.repo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.repo-row .label { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
.repo-row code {
  font-family: var(--mono); font-size: 12.5px; color: var(--fg);
  background: rgba(148, 163, 184, 0.10); border: 1px solid var(--line);
  padding: 3px 8px; border-radius: 8px;
}
textarea {
  width: 100%; resize: vertical; min-height: 56px;
  background: var(--card-2); color: var(--fg);
  border: 1px solid var(--line-strong); border-radius: 12px;
  padding: 12px 14px; font-family: var(--sans); font-size: 14px;
}
textarea:focus, button:focus-visible { outline: 2px solid rgba(34, 197, 94, 0.6); outline-offset: 2px; }
.actions { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
button { font-family: inherit; cursor: pointer; }
#run {
  background: var(--accent); color: #05230F; border: 0;
  padding: 9px 20px; border-radius: 10px; font-weight: 600; font-size: 13.5px;
  transition: transform 120ms ease, filter 120ms ease;
}
#run:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
#run:disabled { opacity: 0.5; cursor: progress; }
.status { font-size: 12.5px; color: var(--muted); min-height: 18px; }
.status.bad { color: var(--danger); }
.presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip {
  background: rgba(148, 163, 184, 0.08); color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px;
  padding: 4px 11px; font-size: 12px; font-family: var(--mono);
  transition: color 120ms ease, border-color 120ms ease;
}
.chip:hover { color: var(--fg); border-color: var(--line-strong); }
.stream {
  margin-top: 16px; padding: 12px; border-radius: 12px;
  background: rgba(15, 23, 42, 0.55); border: 1px solid var(--line);
  max-height: 320px; overflow: auto; font-family: var(--mono); font-size: 12.5px;
}
.ev { padding: 2px 0; color: var(--muted); display: flex; gap: 8px; align-items: baseline; }
.ev.round { color: var(--fg); margin-top: 8px; opacity: 0.9; }
.ev.round:first-child { margin-top: 0; }
.ev-name { color: #7DD3FC; }
.ev-ms { color: #64748B; font-size: 11.5px; }
.ev-prev { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.ev.verify { color: var(--accent); }
.ev.verify.bad { color: var(--danger); }
.ev.repair { color: var(--warn); }
.ev.hint { color: var(--warn); }
.ev.think { color: #64748B; }
.answer { margin-top: 18px; }
.answer h1, .answer h2, .answer h3, .answer h4 { margin: 18px 0 8px; font-size: 15px; letter-spacing: 0.2px; }
.answer h1:first-child, .answer h2:first-child, .answer h3:first-child { margin-top: 0; }
.answer p { margin: 0 0 10px; }
.answer ul, .answer ol { margin: 0 0 12px; padding-left: 20px; }
.answer li { margin: 3px 0; }
.answer strong { color: #E2E8F0; }
.answer code {
  font-family: var(--mono); font-size: 12.5px;
  background: rgba(148, 163, 184, 0.14); padding: 1px 5px; border-radius: 5px;
}
.answer pre.code {
  background: #0B1220; border: 1px solid var(--line); border-radius: 10px;
  padding: 12px; overflow: auto; margin: 0 0 12px;
}
.answer pre.code code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
.cit {
  font-family: var(--mono); font-size: 12px;
  background: rgba(34, 197, 94, 0.12); color: #86EFAC;
  border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 6px;
  padding: 0 5px; margin: 0 1px; transition: background 120ms ease;
}
.cit:hover { background: rgba(34, 197, 94, 0.24); }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.stat {
  font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  background: rgba(148, 163, 184, 0.08); border: 1px solid var(--line);
  border-radius: 8px; padding: 3px 9px;
}
.stat b { color: var(--fg); font-weight: 600; }
.side-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.side-head h2 { font-size: 13px; margin: 0; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.side-tip { font-size: 11.5px; color: #64748B; margin: -4px 0 10px; }
.ratio { font-family: var(--mono); font-size: 12.5px; color: var(--accent); }
.cits { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1 1 auto; min-height: 60px; }
.cits li { margin-bottom: 4px; }
.cit-item {
  width: 100%; display: flex; align-items: center; gap: 8px;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  padding: 5px 8px; text-align: left; color: var(--muted);
  font-family: var(--mono); font-size: 12px;
}
.cit-item:hover { background: rgba(148, 163, 184, 0.08); border-color: var(--line); color: var(--fg); }
.cit-item.bad .cit-raw { color: #FCA5A5; text-decoration: line-through; text-decoration-thickness: 1px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--accent); }
.dot.bad { background: var(--danger); }
.cit-raw { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cit-detail { font-size: 11px; color: #64748B; }
.src-head {
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line);
  font-family: var(--mono); font-size: 12px; color: var(--muted);
}
.src {
  margin: 8px 0 0; padding: 10px; border-radius: 10px;
  background: #0B1220; border: 1px solid var(--line);
  overflow: auto; max-height: 300px;
  font-family: var(--mono); font-size: 12px; line-height: 1.55;
}
.src .ln { color: #475569; user-select: none; display: inline-block; width: 40px; text-align: right; margin-right: 12px; }
.src .hit { background: rgba(34, 197, 94, 0.12); display: block; margin: 0 -10px; padding: 0 10px; }
.empty { color: var(--muted); font-size: 12.5px; font-family: var(--mono); }
`;

/**
 * 客户端脚本。刻意不用模板字符串：这段代码本身被塞进 TS 的模板字符串里，
 * 再嵌套反引号和 ${} 只会让转义变成事故现场。
 */
const CLIENT_JS = `
(function () {
  var snap = window.__CITECODE_SNAPSHOT__ || null;
  var sources = {};
  var running = false;

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CITE_RE = /(?<![A-Za-z0-9_\\-\\/.])([A-Za-z0-9_][A-Za-z0-9_.\\-]*(?:\\/[A-Za-z0-9_.\\-]+)*\\.[A-Za-z0-9]+):(\\d+)(?:-(\\d+))?/g;

  function inline(text) {
    var out = esc(text);
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    return out;
  }

  function withCitations(html) {
    return html.replace(CITE_RE, function (m) {
      return '<button class="cit" type="button" data-raw="' + m + '">' + m + '</button>';
    });
  }

  function renderMarkdown(md) {
    var lines = String(md || '').split(/\\r?\\n/);
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\\s*$/.test(line)) { i++; continue; }

      if (/^\`\`\`/.test(line)) {
        i++;
        var buf = [];
        while (i < lines.length && !/^\`\`\`/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre class="code"><code>' + esc(buf.join('\\n')) + '</code></pre>');
        continue;
      }

      var h = /^(#{1,4})\\s+(.*)$/.exec(line);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + '>' + withCitations(inline(h[2])) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^\\s*[-*]\\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
          items.push('<li>' + withCitations(inline(lines[i].replace(/^\\s*[-*]\\s+/, ''))) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\\s*\\d+[.)]\\s+/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {
          oitems.push('<li>' + withCitations(inline(lines[i].replace(/^\\s*\\d+[.)]\\s+/, ''))) + '</li>');
          i++;
        }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }

      var para = [];
      while (i < lines.length && !/^\\s*$/.test(lines[i]) &&
             !/^\`\`\`/.test(lines[i]) && !/^#{1,4}\\s/.test(lines[i]) &&
             !/^\\s*[-*]\\s+/.test(lines[i]) && !/^\\s*\\d+[.)]\\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + withCitations(inline(para.join(' '))) + '</p>');
    }
    return out.join('');
  }

  function eventRow(ev) {
    if (ev.type === 'round') return '<div class="ev round">第 ' + ev.round + ' 轮</div>';
    if (ev.type === 'tool') {
      return '<div class="ev tool' + (ev.ok ? '' : ' ev-bad') + '">' +
        '<span class="ev-name">' + esc(ev.name) + '</span>' +
        '<span class="ev-ms">' + ev.durationMs + ' ms</span>' +
        '<span class="ev-prev">' + esc(ev.preview) + '</span></div>';
    }
    if (ev.type === 'verify') {
      var ok = ev.total > 0 && ev.verified === ev.total;
      return '<div class="ev verify' + (ok ? '' : ' bad') + '">回读校验 ' + ev.verified + '/' + ev.total + '</div>';
    }
    if (ev.type === 'repair') {
      return '<div class="ev repair">↻ 自校正第 ' + ev.attempt + ' 次 · ' + ev.failed + '/' + ev.total + ' 条未通过</div>';
    }
    if (ev.type === 'hint') return '<div class="ev hint">' + esc(ev.message) + '</div>';
    if (ev.type === 'assistant' && ev.toolCallCount > 0) {
      return '<div class="ev think">→ 请求 ' + ev.toolCallCount + ' 个工具</div>';
    }
    return '';
  }

  function appendEvent(ev) {
    var row = eventRow(ev);
    if (!row) return;
    var box = $('stream');
    box.insertAdjacentHTML('beforeend', row);
    box.scrollTop = box.scrollHeight;
  }

  function statChip(label, value) {
    return '<span class="stat">' + label + ' <b>' + esc(value) + '</b></span>';
  }

  function renderStats(run) {
    var s = run.stats;
    var html = '';
    html += statChip('结束', s.stopReason);
    html += statChip('轮次', s.rounds);
    html += statChip('工具', s.toolCalls);
    html += statChip('token', s.tokens);
    if (s.repairs > 0) html += statChip('自校正', s.repairs + ' 次');
    var elapsed = s.durationMs < 1000 ? s.durationMs + ' ms' : (s.durationMs / 1000).toFixed(1) + ' s';
    html += statChip('耗时', elapsed);
    $('stats').innerHTML = html;
    $('stats').hidden = false;
  }

  function renderCits(run) {
    var items = run.citations.items;
    $('ratio').textContent = run.citations.total === 0
      ? '0 条引用'
      : run.citations.verified + '/' + run.citations.total + ' 通过';

    if (!items.length) {
      $('cits').innerHTML = '<li class="empty">这次回答没有引用</li>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var ok = it.status === 'verified';
      html += '<li><button type="button" class="cit-item' + (ok ? '' : ' bad') + '"' +
        ' data-raw="' + esc(it.raw) + '" data-path="' + esc(it.path) + '"' +
        ' data-start="' + it.startLine + '" data-end="' + it.endLine + '">' +
        '<span class="dot' + (ok ? '' : ' bad') + '"></span>' +
        '<span class="cit-raw">' + esc(it.raw) + '</span>' +
        '<span class="cit-detail">' + esc(ok ? '通过' : (it.detail || it.status)) + '</span>' +
        '</button></li>';
    }
    $('cits').innerHTML = html;
  }

  function paintSource(view, start, end) {
    var head = $('src-head');
    var pre = $('src');
    if (view.error) {
      head.textContent = view.path + ' · ' + view.error;
      head.hidden = false;
      pre.innerHTML = '';
      pre.hidden = true;
      return;
    }
    head.textContent = view.path + ' · 第 ' + start + '-' + end + ' 行';
    head.hidden = false;
    var html = '';
    for (var i = 0; i < view.lines.length; i++) {
      var line = view.lines[i];
      var hit = line.n >= start && line.n <= end;
      html += '<span class="' + (hit ? 'hit' : '') + '"><span class="ln">' + line.n + '</span>' + esc(line.text) + '</span>\\n';
    }
    pre.innerHTML = html;
    pre.hidden = false;
  }

  function showSource(raw, path, start, end) {
    if (sources[raw]) { paintSource(sources[raw], start, end); return; }
    if (snap) return;
    fetch('/api/source?path=' + encodeURIComponent(path) +
          '&start=' + start + '&end=' + end +
          '&raw=' + encodeURIComponent(raw))
      .then(function (res) { return res.json(); })
      .then(function (view) { sources[raw] = view; paintSource(view, start, end); })
      .catch(function (err) { paintSource({ path: path, lines: [], error: err.message }, start, end); });
  }

  document.addEventListener('click', function (event) {
    var cite = event.target.closest('.cit');
    if (cite) {
      var rawValue = cite.getAttribute('data-raw');
      var parts = /^(.*):(\\d+)(?:-(\\d+))?$/.exec(rawValue || '');
      if (parts) showSource(rawValue, parts[1], parseInt(parts[2], 10), parseInt(parts[3] || parts[2], 10));
      return;
    }
    var item = event.target.closest('.cit-item');
    if (item) {
      showSource(
        item.getAttribute('data-raw'),
        item.getAttribute('data-path'),
        parseInt(item.getAttribute('data-start'), 10),
        parseInt(item.getAttribute('data-end'), 10)
      );
    }
  });

  function finish(run) {
    $('answer').innerHTML = renderMarkdown(run.answer);
    $('answer').hidden = false;
    renderCits(run);
    renderStats(run);
    $('status').textContent = '';
    $('status').className = 'status';
  }

  function handleEvent(block) {
    var lines = block.split('\\n');
    var name = 'message';
    var data = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('event:') === 0) name = lines[i].slice(6).trim();
      else if (lines[i].indexOf('data:') === 0) data.push(lines[i].slice(5).trim());
    }
    if (!data.length) return;
    var payload;
    try { payload = JSON.parse(data.join('\\n')); } catch (err) { return; }
    if (name === 'agent') { appendEvent(payload); return; }
    if (name === 'done') { finish(payload); return; }
    if (name === 'error') {
      $('status').textContent = '失败：' + (payload.message || '未知错误');
      $('status').className = 'status bad';
    }
  }

  function runAsk(question, caseId) {
    if (running) return;
    running = true;
    $('run').disabled = true;
    $('status').textContent = '分析中…';
    $('status').className = 'status';
    $('stream').hidden = false;
    $('stream').innerHTML = '';
    $('answer').hidden = true;
    $('answer').innerHTML = '';
    $('stats').hidden = true;
    $('cits').innerHTML = '';
    $('src').hidden = true;
    $('src-head').hidden = true;
    $('ratio').textContent = '—';

    var body = JSON.stringify({ question: question, caseId: caseId || null });
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (err) {
          $('status').textContent = '失败：' + (err.message || res.status);
          $('status').className = 'status bad';
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            running = false;
            $('run').disabled = false;
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var index;
          while ((index = buffer.indexOf('\\n\\n')) >= 0) {
            var block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            handleEvent(block);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      $('status').textContent = '失败：' + err.message;
      $('status').className = 'status bad';
    }).finally(function () {
      running = false;
      $('run').disabled = false;
    });
  }

  if (snap) {
    sources = snap.sources || {};
    $('stream').hidden = false;
    for (var i = 0; i < snap.events.length; i++) appendEvent(snap.events[i]);
    finish(snap);
    $('run').disabled = true;
    $('question').value = snap.question;
    $('status').textContent = '快照（不可再运行）';
  } else {
    var presets = window.__CITECODE_PRESETS__ || [];
    var box = $('presets');
    for (var j = 0; j < presets.length; j++) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = presets[j].id;
      chip.setAttribute('data-id', presets[j].id);
      chip.setAttribute('data-question', presets[j].question);
      box.appendChild(chip);
    }
    box.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      $('question').value = chip.getAttribute('data-question');
      runAsk(chip.getAttribute('data-question'), chip.getAttribute('data-id'));
    });
    $('ask').addEventListener('submit', function (event) {
      event.preventDefault();
      var question = $('question').value.trim();
      if (!question) return;
      runAsk(question, null);
    });
  }
})();
`;

function shellHead(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CiteCode · 引用可验证的代码阅读 Agent</title>
<style>${STYLE}</style>
</head>`;
}

export function renderPage(options: PageOptions): string {
  const snapshot = options.snapshot;
  const toolNames = options.tools.join('、');

  const body = `<body>
<header class="top">
  <div class="brand"><span class="logo">◈</span> <b>CiteCode</b>
    <span class="muted">引用可验证的代码阅读 Agent</span></div>
  <div class="meta">
    <span class="pill">${options.mode === 'replay' ? '回放 · 无需密钥' : '实时'}</span>
    <span class="pill plain">${options.model}</span>
    <span class="pill plain" title="MCP 工具：${toolNames}">${options.tools.length} 个工具</span>
  </div>
</header>
<main class="layout">
  <section class="panel">
    <div class="repo-row">
      <span class="label">仓库</span>
      <code>${options.repoLabel}</code>
      <span class="muted">${options.fileCount} 个可读文件</span>
    </div>
    <form id="ask">
      <textarea id="question" rows="2" placeholder="问一个关于这个代码库的问题，例如：这个服务的 HTTP 入口在哪里？"></textarea>
      <div class="actions">
        <button type="submit" id="run">开始分析</button>
        <span class="status" id="status"></span>
      </div>
      <div class="presets" id="presets"></div>
    </form>
    <div class="stream" id="stream" hidden></div>
    <article class="answer" id="answer" hidden></article>
    <div class="stats" id="stats" hidden></div>
  </section>
  <aside class="panel side">
    <div class="side-head"><h2>引用校验</h2><span class="ratio" id="ratio">—</span></div>
    <div class="side-tip">点击任意引用，在下方查看对应源码</div>
    <ul class="cits" id="cits"><li class="empty">还没有引用</li></ul>
    <div class="src-head" id="src-head" hidden></div>
    <pre class="src" id="src" hidden></pre>
  </aside>
</main>
${snapshot ? `<script>window.__CITECODE_SNAPSHOT__ = ${inlineJson(snapshot)};</script>` : ''}
<script>${options.presets.length > 0 && !snapshot ? `window.__CITECODE_PRESETS__ = ${inlineJson(options.presets)};` : ''}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;

  return `${shellHead()}
${body}`;
}