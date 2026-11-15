// Carries an older app's `solid-js` pins up to the advisory floor `@ultimat3/ui` now peers: every
// manifest's exact, caret or tilde pin below it is raised in its own shape, so the app resolves a
// seroval past every advisory with no `overrides`. A range the app wrote itself is reported whole.

import { SOLID_FLOOR } from '../doctor-advisory-floors';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { mergeResults } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };
const MANIFESTS = ['package.json', 'apps/*/package.json', 'packages/*/package.json'];
const DECLARED = /("solid-js"\s*:\s*")([^"]*)"/g;
const PIN = /^([~^]?)(\d+)\.\d+\.\d+$/;

type Verdict = { readonly kind: 'keep' } | { readonly kind: 'raise'; readonly to: string };

/** One declared range: kept, raised, or `undefined` when it is a shape only the app can judge. */
function judge(range: string): Verdict | undefined {
  const pin = PIN.exec(range);
  if (pin === null) return undefined;
  const [, operator = '', major = ''] = pin;
  // A later major is past the floor already; an earlier one is a migration, not a security floor.
  if (major !== '1') return Number(major) > 1 ? { kind: 'keep' } : undefined;
  const version = range.slice(operator.length);
  return Bun.semver.order(version, SOLID_FLOOR) >= 0
    ? { kind: 'keep' }
    : { kind: 'raise', to: `${operator}${SOLID_FLOOR}` };
}

async function migrate(app: CodemodApp, path: string): Promise<CodemodResult> {
  const source = await app.read(path);
  if (source === undefined) return NOTHING;
  const foreign: string[] = [];
  const next = source.replace(DECLARED, (whole, head: string, range: string) => {
    const verdict = judge(range);
    if (verdict === undefined) {
      foreign.push(range);
      return whole;
    }
    return verdict.kind === 'raise' ? `${head}${verdict.to}"` : whole;
  });
  if (foreign.length > 0) {
    const ranges = foreign.map((range) => `solid-js ${range}`).join(', ');
    const reason = `${ranges} is the app's own range, so the file is left as it is; it must resolve solid-js ${SOLID_FLOOR} or later`;
    return { changed: [], skipped: [{ path, reason }] };
  }
  if (next === source) return NOTHING;
  await app.write(path, next);
  return { changed: [path], skipped: [] };
}

export const codemod: Codemod = {
  id: 'solid-floor',
  // The release whose `@ultimat3/ui` first peers `solid-js ^1.9.18`, and whose scaffold pins it.
  since: '31.28.0',
  summary: `every solid-js pin up to ${SOLID_FLOOR}, the first release past the seroval advisories`,
  async run(app) {
    const found = await Promise.all(MANIFESTS.map((pattern) => app.glob(pattern)));
    const paths = [...new Set(found.flat())].sort();
    const results: CodemodResult[] = [];
    for (const path of paths) results.push(await migrate(app, path));
    return mergeResults(results);
  },
};
