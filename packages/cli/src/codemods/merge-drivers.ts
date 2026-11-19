// 31.49.0: two branches that each generate a feature merge without a hand edit. An existing app
// gains the `.gitattributes` rules, the `bun run setup` step that installs the drivers, and its
// registries one entry per line. Every step is additive: a list this cannot restate is left alone,
// and it still works; it only keeps merging by hand.

import { REGISTRY_FILES, withRegistryLines } from '../registry-lines';
import { BIN_SCRIPTS } from '../templates/scaffold-bin';
import { MERGE_ATTRIBUTES, ROOT_GITATTRIBUTES_PATH } from '../templates/scaffold-gitattributes';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';

const INSTALL_ANCHOR = "await bun('install');\n";
export const INSTALL_STEP = "await x('merge-driver', 'install');\n";

const withAttributes = (held: string | undefined): string | undefined => {
  if (held?.includes('merge=x-registry') === true) return undefined;
  if (held === undefined) return MERGE_ATTRIBUTES;
  return `${held.endsWith('\n') ? held : `${held}\n`}\n${MERGE_ATTRIBUTES}`;
};

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
    if (setup !== undefined && !setup.includes(INSTALL_STEP)) {
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
    return { changed, skipped };
  },
};
