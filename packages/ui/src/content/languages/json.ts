// JSON: a key is a string followed by a colon; everything else is a value or punctuation.

import { defineLanguage } from '../highlight';

export const jsonLanguage = /* @__PURE__ */ defineLanguage(
  'json',
  [
    { kind: 'property', pattern: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/ },
    { kind: 'string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
    { kind: 'number', pattern: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i },
    { kind: 'keyword', pattern: /\b(?:true|false|null)\b/ },
    { kind: 'punctuation', pattern: /[{}[\],:]/ },
  ],
  ['jsonc', 'json5'],
);
