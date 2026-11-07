// The docs site carries the test stack `x new` writes, byte for byte: a copy no check reads drifts
// from its siblings with no red gate (the 2026-11-07 tuning wrote the same settings into three
// stacks and pinned two). Regenerated from the template, never edited by hand.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path join.
import { join } from 'node:path';
import { names } from '../packages/cli/src/templates/naming';
import {
  TEST_COMPOSE_PATH,
  testServicesFiles,
} from '../packages/cli/src/templates/scaffold-test-services';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const APP = 'dummy/docs-site';

describe('unit · a tracked app carries the scaffold test stack unchanged', () => {
  test(`${APP}/${TEST_COMPOSE_PATH} is what x new writes for it`, async () => {
    const pkg: unknown = await Bun.file(join(repoRoot(), APP, 'package.json')).json();
    const name =
      typeof pkg === 'object' && pkg !== null && 'name' in pkg && typeof pkg.name === 'string'
        ? pkg.name
        : '';
    expect(name).not.toBe('');
    const generated = testServicesFiles(names(name)).find(
      (file) => file.path === TEST_COMPOSE_PATH,
    );
    expect(generated).toBeDefined();
    const want =
      typeof generated?.contents === 'string'
        ? generated.contents
        : new TextDecoder().decode(generated?.contents);
    const have = await Bun.file(join(repoRoot(), APP, TEST_COMPOSE_PATH)).text();
    expect(have, `regenerate ${APP}/${TEST_COMPOSE_PATH} from scaffold-test-services.ts`).toBe(
      want,
    );
  });
});
