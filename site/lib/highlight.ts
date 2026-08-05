// Syntax highlighting for fenced code blocks: a token pass for source, a line pass for terminal
// transcripts, and the `<pre>`/`<figure>` shell the stylesheet expects around both.

import { escapeHtml } from './text';

const KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|' +
  'enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|' +
  'instanceof|interface|let|new|null|of|readonly|return|satisfies|set|static|super|' +
  'switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield';

const CODE_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*)', // 1 comment
    '(\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"|`(?:\\\\.|[^`\\\\])*`)', // 2 string
    '\\b(\\d[\\d_.]*[a-z]{0,2})\\b', // 3 number
    `\\b(${KEYWORDS})\\b`, // 4 keyword
    '\\b([A-Z][A-Za-z0-9_]*)\\b', // 5 type
    '\\b([a-zA-Z_$][\\w$]*)(?=\\s*\\()', // 6 call
  ].join('|'),
  'g',
);

const CLASSES = ['tok-comment', 'tok-string', 'tok-number', 'tok-keyword', 'tok-type', 'tok-fn'];

/** Token classes only — no AST, no grammar file. Good enough for the shapes we ship. */
function highlightCode(source: string): string {
  let out = '';
  let last = 0;
  for (const match of source.matchAll(CODE_RE)) {
    const at = match.index ?? 0;
    out += escapeHtml(source.slice(last, at));
    const group = CLASSES.findIndex((_, i) => match[i + 1] !== undefined);
    out += `<span class="${CLASSES[group]}">${escapeHtml(match[0])}</span>`;
    last = at + match[0].length;
  }
  return out + escapeHtml(source.slice(last));
}

/** Terminal transcripts: prompt, command, pass/fail marks, and the 3-line error shape. */
function highlightShell(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const prompt = /^(\s*)\$ (.*)$/.exec(line);
      if (prompt !== null) {
        return `${prompt[1]}<span class="tok-prompt">$ </span><span class="tok-cmd">${escapeHtml(prompt[2] ?? '')}</span>`;
      }
      const mark = /^(\s*)([✓✗])(.*)$/.exec(line);
      if (mark !== null) {
        const cls = mark[2] === '✓' ? 'tok-pass' : 'tok-fail';
        return `${mark[1]}<span class="${cls}">${mark[2]}</span>${escapeHtml(mark[3] ?? '')}`;
      }
      const code = /^(\s*)(X_[A-Z0-9_]+)(:.*)$/.exec(line);
      if (code !== null) {
        return `${code[1]}<span class="tok-code">${code[2]}</span>${escapeHtml(code[3] ?? '')}`;
      }
      const label = /^(\s+)(cause|fix|docs):(\s*)(.*)$/.exec(line);
      if (label !== null) {
        return `${label[1]}<span class="tok-label">${label[2]}:</span>${label[3]}${escapeHtml(label[4] ?? '')}`;
      }
      const diff = /^([+-])(.*)$/.exec(line);
      if (diff !== null) {
        const cls = diff[1] === '+' ? 'tok-added' : 'tok-removed';
        return `<span class="${cls}">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console', 'text', 'diff', 'yaml', '']);

export function renderCode(lang: string, title: string | undefined, source: string): string {
  const body = SHELL_LANGS.has(lang) ? highlightShell(source) : highlightCode(source);
  const cls = SHELL_LANGS.has(lang) && lang !== 'yaml' ? ' class="terminal"' : '';
  const pre = `<pre${cls} tabindex="0"><code${lang === '' ? '' : ` class="language-${lang}"`}>${body}</code></pre>`;
  if (title === undefined) return pre;
  return `<figure class="code-figure"><figcaption><span>${escapeHtml(title)}</span><span>${escapeHtml(lang)}</span></figcaption>${pre}</figure>`;
}
