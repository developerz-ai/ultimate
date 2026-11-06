// TypeScript and JavaScript: comments, strings and templates (line-bounded but for templates and
// block comments, which run to the end of an unterminated input rather than rescanning it).

import { defineLanguage } from '../highlight';

export const tsLanguage = /* @__PURE__ */ defineLanguage(
  'ts',
  [
    { kind: 'comment', pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/ },
    {
      kind: 'string',
      pattern: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?/,
    },
    { kind: 'number', pattern: /\b(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)n?\b/i },
    {
      kind: 'keyword',
      pattern:
        /\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|readonly|return|satisfies|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b/,
    },
    { kind: 'type', pattern: /\b[A-Z][\w$]*\b/ },
    { kind: 'function', pattern: /\b[a-z_$][\w$]*(?=\()/ },
    { kind: 'operator', pattern: /=>|[=!<>]=?=?|&&|\|\||\?\?|[+\-*/%&|^~?]=?/ },
    { kind: 'punctuation', pattern: /[{}()[\];,.:]/ },
  ],
  ['typescript', 'tsx', 'js', 'javascript', 'jsx', 'mjs', 'cjs'],
);
