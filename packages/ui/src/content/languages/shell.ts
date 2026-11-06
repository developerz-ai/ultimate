// POSIX shell: comments, quoted strings, variables, the usual keywords and a command's flags.

import { defineLanguage } from '../highlight';

export const shellLanguage = /* @__PURE__ */ defineLanguage(
  'shell',
  [
    { kind: 'comment', pattern: /(?<![^\s;|&])#[^\n]*/ },
    { kind: 'string', pattern: /"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?/ },
    { kind: 'property', pattern: /\$(?:\{[^}\n]*\}?|\w+|[@*#?$!0-9-])/ },
    {
      kind: 'keyword',
      pattern:
        /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|set|unset)\b/,
    },
    { kind: 'attribute', pattern: /(?<![\w-])--?[\w][\w-]*/ },
    { kind: 'operator', pattern: /&&|\|\||[|&;<>]+/ },
  ],
  ['sh', 'bash', 'zsh', 'console', 'shellsession'],
);
