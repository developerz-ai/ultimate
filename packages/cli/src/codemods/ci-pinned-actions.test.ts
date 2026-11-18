// The ci-pinned-actions codemod: an app's ci.yml and image.yml as 31.42 wrote them (actions by
// movable tag, ci.yml's checkouts keeping the job token) come back byte for byte as `x new`
// writes them today; a workflow the app reworded is reported with the diff, and left alone.

import { describe, expect, test } from 'bun:test';
import { CACHE, CHECKOUT } from '../templates/github/actions';
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

  // Two of nine adopters' workflows held `actions/checkout@v5` (31.44 skipped both): the tag's
  // major is the app's, the pin is the template's, so any tagged major of an action with a pin moves.
  test('a ci.yml on other majors (@v5, @v4) is pinned, its checkouts dropping the token', async () => {
    const other = olderCi
      .replaceAll('actions/checkout@v7\n', 'actions/checkout@v5\n')
      .replaceAll('actions/cache@v6\n', 'actions/cache@v4\n')
      .replaceAll('actions/upload-artifact@v7\n', 'actions/upload-artifact@v4.6.2\n')
      .replaceAll('actions/download-artifact@v8\n', 'actions/download-artifact@v4\n');
    expect(other).toContain('actions/checkout@v5\n');
    expect(other).not.toMatch(/actions\/[a-z-]+@v(?:6|7|8)\n/);
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: other });
    expect(await codemod.run(app)).toEqual({ changed: [CI_WORKFLOW_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today(CI_WORKFLOW_PATH));
  });

  // A checkout the app gave its own `with:` takes the key inside it, never a second `with:`; one
  // written `- name: …` then `uses:` is the same step.
  test("a checkout with the app's own with:, under a name:, keeps its keys and drops the token", async () => {
    const own = [
      'jobs:',
      '  gate:',
      '    steps:',
      '      - name: checkout',
      '        uses: actions/checkout@v4',
      '        with:',
      '          fetch-depth: 0',
      '      - run: bun install',
      '',
    ].join('\n');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    expect(await codemod.run(app)).toEqual({ changed: [CI_WORKFLOW_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(
      [
        'jobs:',
        '  gate:',
        '    steps:',
        '      - name: checkout',
        `        uses: ${CHECKOUT}`,
        '        with:',
        '          persist-credentials: false',
        '          fetch-depth: 0',
        '      - run: bun install',
        '',
      ].join('\n'),
    );
  });

  // A SHA the app (or its Dependabot) chose is a pin already, and an action with no pin here —
  // `actions/setup-node`, anything outside `actions/` — is not this codemod's to move.
  test('an already-SHA-pinned line, an action with no pin and a non-actions step stay as they are', async () => {
    const own = [
      'jobs:',
      '  gate:',
      '    steps:',
      '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
      '      - uses: actions/setup-node@v4',
      '      - uses: oven-sh/setup-bun@v2',
      '      - uses: docker/login-action@v3',
      '      - uses: actions/cache@v4',
      '',
    ].join('\n');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    expect(await codemod.run(app)).toEqual({ changed: [CI_WORKFLOW_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(
      own.replace('      - uses: actions/cache@v4\n', `      - uses: ${CACHE}\n`),
    );
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  // A tagged line in a shape no line edit reads safely (quoted, an inline `with: { … }`) leaves the
  // whole file as it is: half-pinned is no state to write, so the template's change is the diff.
  test('a ci.yml with a tag it cannot read safely is reported with the diff, and left alone', async () => {
    for (const odd of [
      olderCi.replace(
        '      - uses: actions/checkout@v7\n      - uses: oven-sh/setup-bun@',
        '      - uses: actions/checkout@v7\n        with: { fetch-depth: 0 }\n      - uses: oven-sh/setup-bun@',
      ),
      olderCi.replace('      - uses: actions/cache@v6\n', "      - uses: 'actions/cache@v6'\n"),
    ]) {
      expect(odd).not.toBe(olderCi);
      const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: odd });
      const result = await codemod.run(app);
      expect(result.changed).toEqual([]);
      expect(result.skipped.map((skip) => skip.path)).toEqual([CI_WORKFLOW_PATH]);
      expect(result.skipped[0]?.diff).toContain('persist-credentials: false');
      expect(result.skipped[0]?.diff).toContain(CHECKOUT);
      expect(app.files[CI_WORKFLOW_PATH]).toBe(odd);
    }
  });

  test('the ci.yml codemods before it read a pinned workflow as carried, never a hand step', async () => {
    for (const earlier of [ciE2eBrowser, ciServicesEnv]) {
      const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: today(CI_WORKFLOW_PATH) });
      expect(await earlier.run(app)).toEqual({ changed: [], skipped: [] });
    }
  });
});
