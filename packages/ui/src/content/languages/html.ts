// HTML and XML markup: comments, tags, attribute names and values. Text between tags is plain.

import { defineLanguage } from '../highlight';

export const htmlLanguage = /* @__PURE__ */ defineLanguage(
  'html',
  [
    { kind: 'comment', pattern: /<!--[\s\S]*?(?:-->|$)/ },
    { kind: 'meta', pattern: /<!doctype[^>\n]*>?/i },
    { kind: 'tag', pattern: /<\/?[a-z][\w:-]*|\/?>/i },
    { kind: 'string', pattern: /"[^"\n]*"?|'[^'\n]*'?/ },
    { kind: 'attribute', pattern: /\b[a-z_:][\w:.-]*(?==)/i },
    { kind: 'operator', pattern: /=/ },
  ],
  ['xml', 'svg', 'xhtml'],
);
