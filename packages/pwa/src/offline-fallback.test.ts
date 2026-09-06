import { describe, expect, test } from 'bun:test';
import { PwaNoOfflineFallbackError } from './errors';
import { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('requireOfflineFallback', () => {
  test('you cannot ship without one, and the fix is the exact edit', () => {
    let fix = '';
    try {
      requireOfflineFallback(undefined);
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toBe(
      "set pwa: { offline: { fallback: '/offline' } } in app.config.ts, then create the route it names: x g route offline --surface site",
    );
    // The half a string comparison alone would not explain: `<name>.tsx` is not a route file.
    // `registerRoute` refuses it with `X_ROUTE_FILE_INVALID` — the directory is the URL — so the
    // fix this line USED to hand out (`app/offline.tsx`) was an instruction that fails at the
    // first `x verify` after it is followed, and `wiki/Upgrading.md` already records that path as
    // the wrong one. `site/`, not `app/`: the document answering a lost network has to render with
    // no network, no session and no database, which `app/` (`ssr | stream`) cannot promise.
    expect(fix).not.toMatch(/\boffline\.tsx\b/);
    expect(fix).toContain('--surface site');
    // No `#`: a shell comment is what made the previous line half-run. Pasted whole it created the
    // route and left `pwa.offline.fallback` unset, so the next build raised this same error — and
    // the reader had no signal that anything was left to do. Both actions, or neither.
    expect(fix).not.toContain('#');
    // The nested literal and not the dotted key, because there is no `pwa` block to set a key in:
    // this branch fires when the config has none. It is the same line `x doctor`'s own
    // `offlineFallbackFinding` hands out for the same code — two spellings of one instruction is
    // how one of them rots.
    expect(fix).toContain("pwa: { offline: { fallback: '/offline' } }");
    expect(fix).toContain('app.config.ts');

    expect(() => requireOfflineFallback({})).toThrow(PwaNoOfflineFallbackError);
    expect(() => requireOfflineFallback({ fallback: '  ' })).toThrow(PwaNoOfflineFallbackError);
  });

  test('the block-missing and fallback-missing refusals hand out the SAME edit', () => {
    // Two causes, one remedy: "no `offline` block" and "an `offline` block with no `fallback`" are
    // repaired by the same two steps, and two spellings of one instruction is how one of them
    // rots. A caller sees whichever cause applies and the same runnable line either way.
    let blockMissing = '';
    let fallbackMissing = '';
    try {
      requireOfflineFallback(null);
    } catch (error) {
      blockMissing = fixOf(error);
    }
    try {
      requireOfflineFallback({});
    } catch (error) {
      fallbackMissing = fixOf(error);
    }
    expect(blockMissing).toBe(fallbackMissing);
    expect(blockMissing).not.toBe('');
  });

  test('rejects a relative fallback path and suggests the absolute one', () => {
    let fix = '';
    try {
      requireOfflineFallback({ fallback: 'offline' });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("'/offline'");
    // The key's full path, because that is what an author edits: `offline.fallback` names no key
    // `app.config.ts` has, and `pwa.offline.fallback` does.
    expect(fix).toContain('pwa.offline.fallback');
  });

  test('emits a fallback handler covering navigations and images', () => {
    const fallback = requireOfflineFallback({ fallback: '/offline', image: '/offline.svg' });
    expect(fallback.document).toBe('/offline');

    const source = offlineFallbackSource(fallback);
    expect(source).toContain('"/offline"');
    expect(source).toContain("req.mode==='navigate'");
    expect(source).toContain("req.destination==='image'");
  });
});
