// YAML: comments, keys before a colon, quoted scalars, anchors, document markers and list dashes.

import { defineLanguage } from '../highlight';

export const yamlLanguage = /* @__PURE__ */ defineLanguage(
  'yaml',
  [
    { kind: 'comment', pattern: /(?<![^\s])#[^\n]*/ },
    { kind: 'meta', pattern: /^(?:---|\.\.\.)(?=\s|$)/m },
    { kind: 'property', pattern: /[\w.-][\w .-]*(?=:(?:\s|$))/ },
    { kind: 'string', pattern: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\n]|'')*'?/ },
    { kind: 'keyword', pattern: /\b(?:true|false|null|yes|no|on|off)\b/i },
    { kind: 'number', pattern: /-?\b\d+(?:\.\d+)?\b/ },
    { kind: 'attribute', pattern: /[&*][\w-]+|![\w!/-]*/ },
    { kind: 'punctuation', pattern: /[:\-?[\]{},|>]/ },
  ],
  ['yml'],
);
