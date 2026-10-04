// What a real `app.config.ts` on disk resolves to: the three shapes that read as "never swept" — no
// file, no `notify` section, no keys — and the window that is refused rather than read as absent.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `Object.keys(Bun)` has `file`,
// `write` and `Glob`, and nothing that makes or removes a directory tree.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask the platform where its temporary
// directory is.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API, so the temp root and the config file are joined with this.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { loadAppConfig } from './app-config-load';
import { inboxRetentionOf, NO_INBOX_RETENTION } from './runtime-notify-retention';

const loadInboxRetention = async (root: string) => inboxRetentionOf(await loadAppConfig(root));

const dirs: string[] = [];

/** A scratch app root holding exactly the `app.config.ts` a case is about. */
async function appRoot(source: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-notify-retention-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('inboxRetentionOf, over the one loader', () => {
  test('reads both windows out of the app own config', async () => {
    const root = await appRoot(
      "export const config = { name: 'demo', notify: { inboxReadRetentionMs: 2_592_000_000, inboxUnreadRetentionMs: 7_776_000_000 } };\n",
    );
    expect(await loadInboxRetention(root)).toEqual({
      readMs: 2_592_000_000,
      unreadMs: 7_776_000_000,
    });
  });

  // One window is the shape the issue expects an app to actually want: read notices gone in a
  // month, unread ones kept forever. The unset one must stay unset rather than inherit the other.
  test('one window set leaves the other absent', async () => {
    const root = await appRoot(
      "export const config = { name: 'demo', notify: { inboxReadRetentionMs: 60_000 } };\n",
    );
    expect(await loadInboxRetention(root)).toEqual({ readMs: 60_000, unreadMs: undefined });
  });

  test('no config file, no notify section and no keys all read as never swept', async () => {
    expect(await loadInboxRetention(await appRoot(undefined))).toEqual(NO_INBOX_RETENTION);
    expect(
      await loadInboxRetention(await appRoot('export const config = { name: "demo" };\n')),
    ).toEqual(NO_INBOX_RETENTION);
    expect(
      await loadInboxRetention(
        await appRoot('export const config = { name: "demo", notify: {} };\n'),
      ),
    ).toEqual(NO_INBOX_RETENTION);
  });

  // A config object assembled by hand reaches core's validator through the one loader, where it
  // used to be re-screened here and read as "never swept". A `NaN` window would become
  // `new Date(now - NaN)`, a cutoff every row is older than.
  test('a window that is not a positive finite number is refused', async () => {
    for (const literal of ['Number.NaN', '0', '-1', '"30d"', 'null', '{}']) {
      const root = await appRoot(
        `export const config = { name: 'demo', notify: { inboxReadRetentionMs: ${literal} } };\n`,
      );
      const error: unknown = await loadInboxRetention(root).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(isUltimateError(error) ? error.code : 'not coded', literal).toBe('X_CONFIG_INVALID');
    }
  });
});
