// Every process-wide declaration table in `packages/*/src` is accounted for: restored at the file
// boundary, forgotten on a rerun, reported, a boot install by design, or OPEN — listed debt. A new
// one leaks into every later file on a shared (isolate-off) worker, so it cannot land silently:
// this file reds until its row says which, and a row whose file no longer matches reds as stale.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { DECLARATION_TABLES } from './declaration-boundary';

const ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * What makes a file one: a module-scope `Map`/`Set` beside an exported `register*`/`define*`/
 * `note*`/`declare*`. A heuristic, and the direction it errs is a row to write, never a miss of the
 * idiomatic shape — `jobs`' registry and `admin`'s global-symbol mounts do not match it and are
 * restored anyway (`registry-snapshot.ts`, `admin-mount-boundary.ts`).
 */
const TABLE = /^(?:const|let) \w+ = new (?:Map|Set)\b/m;
const DECLARER = /^export (?:function|const) (?:register|define|note|declare)\w*/m;

type Row =
  /** Put back at every file boundary by the named `@ultimat3/testing` module. */
  | { readonly restored: string }
  /** Forgotten when the same file loads again (`rerun-registries.ts`); a body declaration leaks. */
  | { readonly rerun: true }
  /** Reported against the file that left it filled (`registry-leak-guard.ts`), never restored. */
  | { readonly reported: true }
  /** A process-lifetime install by design: additive, idempotent per key, no test un-declares it. */
  | { readonly boot: string }
  /** No restore wired: the debt, named so it is seen. Move it up when its owner publishes one. */
  | { readonly open: string };

const LEDGER: Readonly<Record<string, Row>> = {
  'packages/action/src/registry.ts': { rerun: true },
  'packages/action/src/tool-gate.ts': { open: 'no restore for registered tool gates' },
  'packages/ai/src/agent-facts.ts': { open: 'no restore for agent facts' },
  'packages/ai/src/evals.ts': { open: 'no restore for declared evals' },
  'packages/ai/src/models.ts': { restored: 'declaration-boundary.ts' },
  'packages/ai/src/prompt.ts': { open: 'resetPrompts only — a reset, not a restore' },
  'packages/auth/src/oauth-registry.ts': { rerun: true },
  'packages/auth/src/verification-purposes.ts': { open: 'no restore for purposes' },
  'packages/cache/src/graph.ts': { open: 'no restore for dependents' },
  'packages/cache/src/tags.ts': { reported: true },
  'packages/cli/src/app-load-register.ts': { open: 'the app scan’s per-module record' },
  'packages/cli/src/island-styles.ts': { open: 'no restore for island stylesheets' },
  'packages/core/src/define-error.ts': { boot: 'an app error code, one site per code' },
  'packages/core/src/env.ts': { boot: 'the env schema, declared once per process' },
  'packages/core/src/error-codes.ts': { boot: 'a code is registered forever' },
  'packages/core/src/error-retry.ts': { boot: 'keyed by code, as the codes are' },
  'packages/core/src/error-status-declared.ts': { boot: 'keyed by code, as the codes are' },
  'packages/core/src/lifecycle-readiness.ts': { open: 'readiness checks have no restore' },
  'packages/core/src/problem-meta-declared.ts': { boot: 'keyed by code, as the codes are' },
  'packages/core/src/public-cause.ts': { boot: 'keyed by code, as the codes are' },
  'packages/core/src/registrar.ts': { boot: 'one registrar per primitive kind, framework-wide' },
  'packages/core/src/service.ts': { rerun: true },
  'packages/entity/src/driver-registry.ts': { restored: 'driver-store-boundary.ts' },
  'packages/entity/src/registry.ts': { rerun: true },
  'packages/flags/src/registry.ts': { open: 'no restore for flags' },
  'packages/i18n/src/context.ts': { restored: 'registry-snapshot.ts' },
  'packages/jobs/src/task.ts': { restored: 'registry-snapshot.ts' },
  'packages/mail/src/layout.ts': { rerun: true },
  'packages/mail/src/mail.ts': { rerun: true },
  'packages/mcp/src/recipe-links.ts': { restored: 'declaration-boundary.ts' },
  'packages/mcp/src/remote-tools.ts': { restored: 'declaration-boundary.ts' },
  'packages/money/src/currency.ts': { boot: 'ISO 4217 rows, keyed by code' },
  'packages/policy/src/permissions.ts': { restored: 'registry-snapshot.ts' },
  'packages/query/src/registry.ts': { rerun: true },
  'packages/realtime/src/channel-registry.ts': { restored: 'declaration-boundary.ts' },
  'packages/realtime/src/device-socket.ts': { open: 'no restore for device sockets' },
  'packages/render/src/module-loader.ts': { open: 'no restore for stylesheets' },
  'packages/render/src/registry.ts': { restored: 'declaration-boundary.ts' },
  'packages/testing/src/factories.ts': { open: 'defineFactory has no restore' },
};

const FIX =
  'add a row to LEDGER in packages/testing/src/process-registries.test.ts — and, to restore it, a row to DECLARATION_TABLES in packages/testing/src/declaration-boundary.ts over an exact restore its package publishes';

async function declarationTables(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of new Bun.Glob('packages/*/src/**/*.ts').scanSync({ cwd: ROOT })) {
    const file = path.replaceAll('\\', '/');
    if (/\.(?:test|d)\.ts$|fixture/.test(file)) continue;
    const text = await Bun.file(join(ROOT, file)).text();
    if (TABLE.test(text) && DECLARER.test(text)) found.push(file);
  }
  return found.sort();
}

describe('unit · every process-wide declaration table is accounted for', () => {
  test('each one the scan finds has a ledger row, and each row still names one', async () => {
    const found = await declarationTables();
    const unlisted = found.filter((file) => LEDGER[file] === undefined);
    const stale = Object.keys(LEDGER).filter((file) => !found.includes(file));
    expect({ unlisted, stale, fix: FIX }).toEqual({ unlisted: [], stale: [], fix: FIX });
  });

  test('every row restored by declaration-boundary.ts has its table there', () => {
    const owner = (file: string): string => {
      const [, pkg, rest] = /^packages\/([^/]+)\/src\/(.+)$/.exec(file) ?? [];
      return `@ultimat3/${pkg}/${rest}`;
    };
    const restoredHere = Object.entries(LEDGER)
      .filter(([, row]) => 'restored' in row && row.restored === 'declaration-boundary.ts')
      .map(([file]) => owner(file));
    const tables = new Set(DECLARATION_TABLES.map((table) => table.owner));
    expect(restoredHere.filter((name) => !tables.has(name))).toEqual([]);
  });
});
