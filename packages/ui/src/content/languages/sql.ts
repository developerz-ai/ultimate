// SQL: comments, strings, quoted identifiers and the keywords Postgres reads most.

import { defineLanguage } from '../highlight';

export const sqlLanguage = /* @__PURE__ */ defineLanguage(
  'sql',
  [
    { kind: 'comment', pattern: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/ },
    { kind: 'string', pattern: /'(?:[^']|'')*'?/ },
    { kind: 'property', pattern: /"(?:[^"]|"")*"?/ },
    { kind: 'number', pattern: /\b\d+(?:\.\d+)?\b/ },
    {
      kind: 'keyword',
      pattern:
        /\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|alter|drop|table|index|view|on|join|left|right|inner|outer|cross|group|by|order|having|limit|offset|as|distinct|union|all|case|when|then|else|end|null|is|in|exists|between|like|ilike|primary|key|references|foreign|unique|default|constraint|returning|with|begin|commit|rollback|asc|desc|true|false|check|cascade)\b/i,
    },
    {
      kind: 'type',
      pattern:
        /\b(?:int|integer|bigint|smallint|text|varchar|char|boolean|bool|uuid|jsonb?|timestamptz?|date|numeric|serial|bigserial|bytea)\b/i,
    },
    { kind: 'function', pattern: /\b[a-z_]\w*(?=\()/i },
    { kind: 'operator', pattern: /[=<>!]=?|<>|::|\|\||[+\-*/%]/ },
    { kind: 'punctuation', pattern: /[(),;.]/ },
  ],
  ['postgres', 'postgresql', 'psql', 'pgsql'],
);
