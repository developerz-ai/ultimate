// The ci-services-env codemod: the services part's `cat` of the env file becomes the `grep` of its
// `TEST_` lines `x new` writes today — GitHub refused the file's `#` header in $GITHUB_ENV.

import { describe, expect, test } from 'bun:test';
import { CI_WORKFLOW_PATH, githubFiles } from '../templates/github/ci.yml';
import { names } from '../templates/naming';
import { codemod as ciE2eBrowser } from './ci-e2e-browser';
import { CI_SERVICES_ENV_EDITS, codemod } from './ci-services-env';
import { memoryCodemodApp } from './codemod';

const today = String(githubFiles(names('shop')).find((f) => f.path === CI_WORKFLOW_PATH)?.contents);
const [edit] = CI_SERVICES_ENV_EDITS;
const older = today.replace(edit?.to ?? '', edit?.from ?? '');

describe('unit · codemod ci-services-env', () => {
  test('a ci.yml as 31.39 wrote it comes back as x new writes it today, and stays', async () => {
    expect(older).not.toBe(today);
    expect(older).toContain('cat docker/test-services.env >> "$GITHUB_ENV"');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: older });
    expect(await codemod.run(app)).toEqual({ changed: [CI_WORKFLOW_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('the e2e codemod before it still reads a 31.40 workflow as carried, never a hand step', async () => {
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: today });
    expect(await ciE2eBrowser.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a ci.yml that appends its own way is reported with the diff, and left alone', async () => {
    const own = today.replace(edit?.to ?? '', '          echo mine >> "$GITHUB_ENV"');
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: own });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });
});
