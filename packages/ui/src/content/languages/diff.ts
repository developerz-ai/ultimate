// A unified diff as text: file headers, hunk headers, and whole added and removed lines.

import { defineLanguage } from '../highlight';

export const diffLanguage = /* @__PURE__ */ defineLanguage(
  'diff',
  [
    { kind: 'meta', pattern: /^(?:diff |index |--- |\+\+\+ )[^\n]*/m },
    { kind: 'keyword', pattern: /^@@[^\n]*/m },
    { kind: 'inserted', pattern: /^\+[^\n]*/m },
    { kind: 'deleted', pattern: /^-[^\n]*/m },
  ],
  ['patch', 'udiff'],
);
