// 31.27.0: the test stack's host ports are the app's own (its name picks an offset into each band),
// so two apps on one machine stop dialling each other's Postgres. The compose file publishes what
// the env file names, so they move together, only while both are the old scaffold's byte for byte;
// otherwise neither moves and each is reported with its diff.

import type { NameSet } from '../templates/naming';
import { names } from '../templates/naming';
import {
  TEST_COMPOSE_PATH,
  TEST_ENV_PATH,
  TEST_PORTS,
  testPorts,
  testServicesFiles,
} from '../templates/scaffold-test-services';
import type { Codemod, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import type { FileText } from './engine-edits';
import { readText } from './engine-edits';

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

interface PortFile {
  readonly path: string;
  readonly today: string;
  readonly old: string;
  readonly file: FileText | undefined;
}

const isMovable = ({ file, today, old }: PortFile): boolean =>
  file !== undefined && (file.text === today || file.text === old);

/** Every file still short of today's, each with why it stays and the change to make by hand. */
function heldBack(files: readonly PortFile[]): CodemodResult {
  const blockers = files.filter((one) => !isMovable(one)).map((one) => one.path);
  const skipped = files.flatMap(({ path, today, old, file }) => {
    if (file === undefined || file.text === today) return [];
    const reason = blockers.includes(path)
      ? "it is no longer the old scaffold's file byte for byte, so the test ports stay in both files: the diff is the scaffold's change, to make by hand in both if two apps share this machine"
      : `${blockers.join(' and ')} cannot move with it, and the two must name the same ports, so this file stays too: the diff is the scaffold's change, to make by hand in both if two apps share this machine`;
    return [{ path, reason, diff: unifiedDiff(path, old, today) }];
  });
  return { changed: [], skipped };
}

export const codemod: Codemod = {
  id: 'test-ports',
  since: '31.27.0',
  summary: `${TEST_COMPOSE_PATH} and ${TEST_ENV_PATH} publish this app's own test ports, so two apps on one machine run at once`,
  async run(app) {
    const kebab = appName((await readText(app, TEST_ENV_PATH))?.text ?? '');
    if (kebab === undefined) return NOTHING;
    const name = names(kebab);
    const files: PortFile[] = [];
    for (const { path, contents } of testServicesFiles(name)) {
      if (typeof contents !== 'string') continue;
      const old = before(contents, name);
      files.push({ path, today: contents, old, file: await readText(app, path) });
    }
    if (!files.every(isMovable)) return heldBack(files);
    const changed: string[] = [];
    for (const { path, today, file } of files) {
      if (file === undefined || file.text === today) continue;
      await app.write(path, file.restore(today));
      changed.push(path);
    }
    return { changed, skipped: [] };
  },
};
