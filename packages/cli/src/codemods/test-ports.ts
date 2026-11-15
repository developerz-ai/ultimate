// 31.27.0: the test stack's host ports are the app's own (its name picks an offset into each band),
// so two apps on one machine stop dialling each other's Postgres. Only a compose file and env file
// still byte-for-byte the old scaffold's move; an edited one is reported with the diff.

import type { NameSet } from '../templates/naming';
import { names } from '../templates/naming';
import {
  TEST_COMPOSE_PATH,
  TEST_ENV_PATH,
  TEST_PORTS,
  testPorts,
  testServicesFiles,
} from '../templates/scaffold-test-services';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import { mergeResults } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** The compose comment the old scaffold wrote, and today's. */
const OLD_NOTE =
  "# and a suite that needs a real server skips. Ports are the dev stack's plus 50000, so both run.";
const NEW_NOTE = [
  "# and a suite that needs a real server skips. Ports are this app's own (its name picks",
  "# them), above the dev stack's, so both stacks — and two apps — run at once.",
].join('\n');

/** The app's name, as the old env file spells it in its database URL. */
const appName = (env: string): string | undefined =>
  /^TEST_DATABASE_URL=postgres:\/\/([a-z0-9-]+):\1-test@/m.exec(env)?.[1];

/** Today's file with the old fixed ports and comment: what the old scaffold wrote for this app. */
function before(today: string, app: NameSet): string {
  const ports = testPorts(app);
  let text = today.replace(NEW_NOTE, () => OLD_NOTE);
  for (const key of Object.keys(TEST_PORTS) as (keyof typeof TEST_PORTS)[]) {
    text = text.replaceAll(
      `127.0.0.1:${String(ports[key])}`,
      `127.0.0.1:${String(TEST_PORTS[key])}`,
    );
  }
  return text;
}

async function move(
  app: CodemodApp,
  path: string,
  today: string,
  name: NameSet,
): Promise<CodemodResult> {
  const held = await app.read(path);
  if (held === undefined || held === today) return NOTHING;
  const old = before(today, name);
  if (held === old) {
    await app.write(path, today);
    return { changed: [path], skipped: [] };
  }
  return {
    changed: [],
    skipped: [
      {
        path,
        reason:
          "it is no longer the old scaffold's file byte for byte, so its ports stay: the diff is the scaffold's change, to make by hand if two apps share this machine",
        diff: unifiedDiff(path, old, today),
      },
    ],
  };
}

export const codemod: Codemod = {
  id: 'test-ports',
  since: '31.27.0',
  summary: `${TEST_COMPOSE_PATH} and ${TEST_ENV_PATH} publish this app's own test ports, so two apps on one machine run at once`,
  async run(app) {
    const kebab = appName((await app.read(TEST_ENV_PATH)) ?? '');
    if (kebab === undefined) return NOTHING;
    const name = names(kebab);
    const results: CodemodResult[] = [];
    for (const file of testServicesFiles(name)) {
      if (typeof file.contents === 'string')
        results.push(await move(app, file.path, file.contents, name));
    }
    return mergeResults(results);
  },
};
