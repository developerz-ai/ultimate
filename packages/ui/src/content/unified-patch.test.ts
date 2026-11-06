// Reading a unified patch: headers, numbering from each hunk's start, the no-newline marker, and
// malformed lines kept rather than dropped.

import { expect, test } from 'bun:test';
import { parseUnifiedPatch } from './unified-patch';

const PATCH = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,3 +10,3 @@ fn
 keep
-const a = 1;
+const a = 2;
 keep
\\ No newline at end of file
`;

test('a git patch reads to file, hunk and numbered rows', () => {
  const rows = parseUnifiedPatch(PATCH);
  expect(rows.map((row) => row.kind)).toEqual([
    'file',
    'file',
    'file',
    'hunk',
    'context',
    'del',
    'add',
    'context',
  ]);
  expect(rows[4]).toMatchObject({ old: 10, new: 10, text: 'keep' });
  expect(rows[5]).toMatchObject({ kind: 'del', old: 11, text: 'const a = 1;' });
  expect(rows[6]).toMatchObject({ kind: 'add', new: 11, text: 'const a = 2;' });
  expect(rows[7]).toMatchObject({ old: 12, new: 12 });
});

test('the changed pair is word-marked', () => {
  const add = parseUnifiedPatch(PATCH)[6];
  expect(add && 'marks' in add ? add.marks : null).toEqual([[10, 11]]);
});

test('text that is not a patch is kept, never thrown on', () => {
  expect(parseUnifiedPatch('just words')).toEqual([{ kind: 'file', text: 'just words' }]);
  expect(parseUnifiedPatch('')).toEqual([]);
});
