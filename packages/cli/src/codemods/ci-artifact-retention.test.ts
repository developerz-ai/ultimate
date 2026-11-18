// The ci-artifact-retention codemod: a ci.yml whose `verify-part-*` upload kept GitHub's 90-day
// default comes back as `x new` writes it today, with `retention-days: 1`; an upload the app already
// gave a retention, or a workflow with no such upload, is left as it is.

import { describe, expect, test } from 'bun:test';
import { CI_WORKFLOW_PATH, githubFiles } from '../templates/github/ci.yml';
import { names } from '../templates/naming';
import { codemod, RETENTION_LINES } from './ci-artifact-retention';
import { codemod as ciPinnedActions } from './ci-pinned-actions';
import { memoryCodemodApp } from './codemod';

const today = String(githubFiles(names('shop')).find((f) => f.path === CI_WORKFLOW_PATH)?.contents);
/** Spelled here, not read off the codemod, so a dropped insert fails the trip. */
const RETENTION = '          retention-days: 1\n';
const older = today.replace(RETENTION_LINES, '');

describe('unit · codemod ci-artifact-retention', () => {
  test('a ci.yml as 31.44 wrote it comes back as x new writes it today, and stays', async () => {
    expect(today).toContain(RETENTION);
    expect(older).not.toContain('retention-days');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: older });
    expect(await codemod.run(app)).toEqual({ changed: [CI_WORKFLOW_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('an upload in a shape the scaffold never wrote still gets its retention, CRLF kept', async () => {
    const own = older
      .replace('          overwrite: true\n', '')
      .replace('          if-no-files-found: error\n', '          compression-level: 0\n')
      .replaceAll('\n', '\r\n');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    expect((await codemod.run(app)).changed).toEqual([CI_WORKFLOW_PATH]);
    const written = String(app.files[CI_WORKFLOW_PATH]);
    expect(written).toContain(
      `          compression-level: 0\r\n${RETENTION_LINES.replaceAll('\n', '\r\n')}`,
    );
    expect(written.split('retention-days').length - 1).toBe(1);
  });

  test("an upload with the app's own retention is the app's, and left alone", async () => {
    const own = older.replace('          overwrite: true\n', '          retention-days: 7\n');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });

  test('a workflow with no verify-part upload, or no workflow, is nothing to do', async () => {
    const plain = 'jobs:\n  gate:\n    steps:\n      - run: bun run verify\n';
    expect(await codemod.run(memoryCodemodApp({ [CI_WORKFLOW_PATH]: plain }))).toEqual({
      changed: [],
      skipped: [],
    });
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });

  test('the pinned-actions codemod before it reads the workflow today as carried', async () => {
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: today });
    expect(await ciPinnedActions.run(app)).toEqual({ changed: [], skipped: [] });
  });
});
