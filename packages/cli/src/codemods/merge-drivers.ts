// 31.49.0: two branches that each generate a feature merge without a hand edit. An existing app
// gains the `.gitattributes` rules, the `bun run setup` step that installs the drivers, and its
// registries one entry per line, the spread `api/index.ts` with a test that loads it. Additive: a
// list or a setup this cannot restate is left alone and reported; it only keeps merging by hand.

import { isJsonObject, stringField } from '@ultimat3/core';
import { API_INDEX } from '../app-root';
import { REGISTRY_FILES, withRegistryLines } from '../registry-lines';
import { BIN_SCRIPTS } from '../templates/scaffold-bin';
import { MERGE_ATTRIBUTES, ROOT_GITATTRIBUTES_PATH } from '../templates/scaffold-gitattributes';
import type { Codemod, CodemodApp, CodemodResult, CodemodSkip } from './codemod';

const INSTALL_ANCHOR = "await bun('install');\n";
export const INSTALL_STEP = "await x('merge-driver', 'install');\n";
/** The same step for a setup script that is not `bin/setup.ts`: a shell line, pasted by hand. */
export const SHELL_INSTALL_STEP = 'bunx x merge-driver install';

const withAttributes = (held: string | undefined): string | undefined => {
  if (held?.includes('merge=x-registry') === true) return undefined;
  if (held === undefined) return MERGE_ATTRIBUTES;
  return `${held.endsWith('\n') ? held : `${held}\n`}\n${MERGE_ATTRIBUTES}`;
};

export const API_INDEX_TEST = API_INDEX.replace(/\.ts$/, '.test.ts');

/**
 * The registration test, for an app `x new` wrote before it shipped `api/index.test.ts`. One row
 * per entry is more lines, and an index no unit test loads weighs every one of them at 0% against
 * the coverage floor — an upgrade that changed no behaviour went red. Generic on purpose: it reads
 * the lists back, so it holds for any app's registrations.
 */
export const apiIndexTest =
  (): string => `// The registration, read back: importing the index runs \`defineApi\`, and every primitive it
// lists is registered under the export name it was handed over as.
import { expect, unitTest } from '@ultimat3/testing';
import { api } from './index';

unitTest('every listed primitive is registered under its export name', () => {
  const lists: readonly object[] = [api.actions, api.queries, api.jobs, api.tasks];
  for (const list of lists) {
    for (const [name, primitive] of Object.entries(list)) {
      expect(primitive).toHaveProperty('name', name);
    }
  }
});
`;

/** The index declares `api`, so the generic test has something to import; else it is reported. */
const EXPORTS_API = /^export const api = defineApi\(/m;

/** `scripts.setup` from the app's package.json, when it declares one. */
const setupCommand = (manifest: string | undefined): string | undefined => {
  if (manifest === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return undefined;
  }
  const scripts = isJsonObject(parsed) ? parsed['scripts'] : undefined;
  return isJsonObject(scripts) ? stringField(scripts, 'setup') : undefined;
};

/**
 * A setup that is not `bin/setup.ts` (a bash `bin/setup`, a Makefile) is never edited — a shell
 * script has no anchor this can trust — but it is always reported, naming the file `bun run setup`
 * runs when the app holds it, else `package.json`, unless that file already installs the drivers.
 */
async function foreignSetup(app: CodemodApp): Promise<CodemodSkip | undefined> {
  const command = setupCommand(await app.read('package.json'));
  for (const token of command?.split(/\s+/) ?? []) {
    const path = token.replace(/^\.\//, '');
    const held = path === '' ? undefined : await app.read(path);
    if (held === undefined) continue;
    if (held.includes('merge-driver install')) return undefined;
    return {
      path,
      reason: `bun run setup runs ${path}, not ${BIN_SCRIPTS.setup}; add the line ${SHELL_INSTALL_STEP} after its install step`,
    };
  }
  return {
    path: 'package.json',
    reason: `no ${BIN_SCRIPTS.setup} and no setup script file in the app; add ${SHELL_INSTALL_STEP} to whatever bun run setup runs, after its install step`,
  };
}

async function edit(
  app: CodemodApp,
  path: string,
  change: (held: string) => string | undefined,
  changed: string[],
): Promise<void> {
  const held = await app.read(path);
  if (held === undefined) return;
  const next = change(held);
  if (next === undefined || next === held) return;
  await app.write(path, next);
  changed.push(path);
}

export const codemod: Codemod = {
  id: 'merge-drivers',
  since: '31.49.0',
  summary: 'parallel branches merge generated features: drivers, setup step, one entry per line',
  async run(app): Promise<CodemodResult> {
    const changed: string[] = [];
    const skipped: CodemodResult['skipped'] = [];
    const attributes = withAttributes(await app.read(ROOT_GITATTRIBUTES_PATH));
    if (attributes !== undefined) {
      await app.write(ROOT_GITATTRIBUTES_PATH, attributes);
      changed.push(ROOT_GITATTRIBUTES_PATH);
    }
    const setup = await app.read(BIN_SCRIPTS.setup);
    if (setup === undefined) {
      const skip = await foreignSetup(app);
      if (skip !== undefined) skipped.push(skip);
    } else if (!setup.includes(INSTALL_STEP)) {
      if (setup.includes(INSTALL_ANCHOR)) {
        await app.write(
          BIN_SCRIPTS.setup,
          setup.replace(INSTALL_ANCHOR, `${INSTALL_ANCHOR}${INSTALL_STEP}`),
        );
        changed.push(BIN_SCRIPTS.setup);
      } else {
        skipped.push({
          path: BIN_SCRIPTS.setup,
          reason: `no "${INSTALL_ANCHOR.trim()}" line to follow; add ${INSTALL_STEP.trim()} after your install step`,
        });
      }
    }
    for (const path of REGISTRY_FILES) {
      await edit(app, path, (held) => withRegistryLines(path, held), changed);
    }
    if (changed.includes(API_INDEX) && !(await app.exists(API_INDEX_TEST))) {
      if (EXPORTS_API.test((await app.read(API_INDEX)) ?? '')) {
        await app.write(API_INDEX_TEST, apiIndexTest());
        changed.push(API_INDEX_TEST);
      } else {
        skipped.push({
          path: API_INDEX_TEST,
          reason: `${API_INDEX} now lists one entry per line and no unit test loads it, so its lines count at 0% against the coverage floor; write a test that imports it`,
        });
      }
    }
    return { changed, skipped };
  },
};
