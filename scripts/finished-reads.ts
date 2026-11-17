// The finished table's reads of the working tree, apart from the rules that judge them: each tracked
// app's gate floor, every ratchet table with its source, and every plan tracker's status. Each takes
// the root, so a test points it at a fixture tree.

import type { GatedAppRead } from './finished-gate';
import type { TrackerRead } from './finished-ledger';
import { PIN_TABLE_NAME, type PinTableRead } from './finished-pins';
import { GATED_APPS } from './lib/gated-apps';
import { PIN_GLOB, SCRIPT_PIN_TABLES } from './lib/pin-tables';
import { PLAN_STATUS_GLOB } from './plan-status';

const json = async (path: string): Promise<unknown> => {
  try {
    return (await Bun.file(path).json()) as unknown;
  } catch {
    // Missing or not JSON: the gate row reports the floor it could not read.
    return undefined;
  }
};

export async function readGatedApps(root: string): Promise<readonly GatedAppRead[]> {
  return Promise.all(
    GATED_APPS.map(async (app) => ({
      dir: app.dir,
      expectedRed: app.expectedRed,
      floor: await json(`${root}/${app.dir}/x.verify.json`),
    })),
  );
}

/**
 * Every ratchet: each `*_PINS`/`*_UNPINNED`/`*BACKLOG` export of `scripts/lib/*-pins.ts`, and each
 * table `pin-raises` reads out of a script. `GATED_APPS` is the gate row's, not this one's.
 */
export async function readPinTables(root: string): Promise<readonly PinTableRead[]> {
  const sites: { path: string; tables?: readonly string[] }[] = [];
  for await (const path of new Bun.Glob(PIN_GLOB).scan({ cwd: root })) {
    sites.push({ path: path.replaceAll('\\', '/') });
  }
  for (const spec of SCRIPT_PIN_TABLES) {
    if (spec.table !== 'GATED_APPS') sites.push({ path: spec.path, tables: [spec.table] });
  }
  const tables: PinTableRead[] = [];
  for (const site of sites.sort((a, b) => a.path.localeCompare(b.path))) {
    const module: Readonly<Record<string, unknown>> = await import(`${root}/${site.path}`);
    const source = await Bun.file(`${root}/${site.path}`).text();
    for (const [table, value] of Object.entries(module)) {
      const wanted = site.tables?.includes(table) ?? PIN_TABLE_NAME.test(table);
      if (wanted && typeof value === 'object' && value !== null) {
        tables.push({ path: site.path, table, value, source });
      }
    }
  }
  return tables;
}

export async function readTrackers(root: string): Promise<readonly TrackerRead[]> {
  const trackers: TrackerRead[] = [];
  for await (const path of new Bun.Glob(PLAN_STATUS_GLOB).scan({ cwd: root })) {
    const doc: unknown = Bun.YAML.parse(await Bun.file(`${root}/${path}`).text());
    const status = typeof doc === 'object' && doc !== null ? Reflect.get(doc, 'status') : undefined;
    trackers.push({ path: path.replaceAll('\\', '/'), status });
  }
  return trackers.sort((a, b) => a.path.localeCompare(b.path));
}
