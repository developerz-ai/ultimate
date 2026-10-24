import { corpus } from './lib/corpus';
import { repoRoot } from './lib/run';

const files = await corpus(repoRoot(), 'shipped');
const shapes = new Map<string, string[]>();
for (const f of files) {
  const lines = f.source.split(/\r?\n/);
  let at = 0;
  while (at < lines.length && (lines[at]?.startsWith('#!') || lines[at]?.trim() === '')) at += 1;
  const first = lines[at]?.trimStart() ?? '';
  if (!first.startsWith('/*')) continue;
  const close = first.indexOf('*/');
  const key = close === -1 ? 'multi-line' : `one-line(${first.slice(0, 40)})`;
  const arr = shapes.get(key) ?? [];
  arr.push(f.path);
  shapes.set(key, arr);
}
for (const [k, v] of shapes) console.log(k, '=>', v.length, v.slice(0, 3).join(', '));
