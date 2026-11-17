// The ci-pinned-actions codemod: an app's ci.yml and image.yml as 31.42 wrote them (actions by
// movable tag, ci.yml's checkouts keeping the job token) come back byte for byte as `x new`
// writes them today; a workflow the app reworded is reported with the diff, and left alone.

import { describe, expect, test } from 'bun:test';
import { CI_WORKFLOW_PATH, githubFiles } from '../templates/github/ci.yml';
import { IMAGE_WORKFLOW_PATH } from '../templates/github/image.yml';
import { names } from '../templates/naming';
import { codemod as ciE2eBrowser } from './ci-e2e-browser';
import { codemod } from './ci-pinned-actions';
import { codemod as ciServicesEnv } from './ci-services-env';
import { memoryCodemodApp } from './codemod';

const today = (path: string): string =>
  String(githubFiles(names('shop')).find((file) => file.path === path)?.contents);

/** 31.42's tags, spelled here and not read off the codemod, so a dropped edit fails the trip. */
const TAGS: Readonly<Record<string, string>> = {
  checkout: 'v7',
  cache: 'v6',
  'upload-artifact': 'v7',
  'download-artifact': 'v8',
};

/** Today's workflow with each pin back on its 31.42 tag and the checkout's token kept. */
const older = (path: string): string =>
  today(path)
    .replaceAll(
      /^( {6}- uses: actions\/checkout@)[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}persist-credentials: false\n( {6}- uses: oven-sh)/gm,
      `$1${TAGS['checkout']}\n$2`,
    )
    .replaceAll(
      /^( {6}- uses: actions\/([a-z-]+)@)[0-9a-f]{40} # v[\d.]+$/gm,
      (_, head: string, name: string) => `${head}${TAGS[name] ?? '?'}`,
    );

const olderCi = older(CI_WORKFLOW_PATH);
const olderImage = older(IMAGE_WORKFLOW_PATH);

describe('unit · codemod ci-pinned-actions', () => {
  test('both workflows as 31.42 wrote them come back as x new writes them today, and stay', async () => {
    expect(olderCi).toContain(
      '      - uses: actions/checkout@v7\n      - uses: oven-sh/setup-bun@',
    );
    for (const [name, tag] of Object.entries(TAGS))
      expect(olderCi).toContain(`actions/${name}@${tag}\n`);
    expect(olderCi).not.toContain('persist-credentials');
    expect(olderImage).toContain('      - uses: actions/checkout@v7\n');
    const app = memoryCodemodApp({
      [CI_WORKFLOW_PATH]: olderCi,
      [IMAGE_WORKFLOW_PATH]: olderImage,
    });
    expect(await codemod.run(app)).toEqual({
      changed: [CI_WORKFLOW_PATH, IMAGE_WORKFLOW_PATH],
      skipped: [],
    });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today(CI_WORKFLOW_PATH));
    expect(app.files[IMAGE_WORKFLOW_PATH]).toBe(today(IMAGE_WORKFLOW_PATH));
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a CRLF checkout keeps its line endings', async () => {
    const crlf = olderImage.replaceAll('\n', '\r\n');
    const app = memoryCodemodApp({ [IMAGE_WORKFLOW_PATH]: crlf });
    expect((await codemod.run(app)).changed).toEqual([IMAGE_WORKFLOW_PATH]);
    expect(app.files[IMAGE_WORKFLOW_PATH]).toBe(
      today(IMAGE_WORKFLOW_PATH).replaceAll('\n', '\r\n'),
    );
  });

  test('an app with no workflows is nothing to do', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });

  // A checkout the app gave its own `with:` cannot take a second one: half-pinned is no state to
  // write, so the whole file is the author's, with the template's change as the diff.
  test('a ci.yml with a tag the edits do not cover is reported with the diff, and left alone', async () => {
    const own = olderCi.replace(
      '      - uses: actions/checkout@v7\n      - uses: oven-sh/setup-bun@',
      '      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n      - uses: oven-sh/setup-bun@',
    );
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual([CI_WORKFLOW_PATH]);
    expect(result.skipped[0]?.diff).toContain('persist-credentials: false');
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });

  test('the ci.yml codemods before it read a pinned workflow as carried, never a hand step', async () => {
    for (const earlier of [ciE2eBrowser, ciServicesEnv]) {
      const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: today(CI_WORKFLOW_PATH) });
      expect(await earlier.run(app)).toEqual({ changed: [], skipped: [] });
    }
  });
});
