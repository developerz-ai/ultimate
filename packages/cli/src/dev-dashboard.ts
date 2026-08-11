// Mounting `@ultimat3/admin`'s `/_x` dashboard in the `x dev` process. The CLI contributes only
// what no registry holds — a SQL runner on the live dev database, the caught outbox, the committed
// manifest, and two panels of process facts — and projects the dashboard onto HTTP routes.
// A panel implemented here instead of in `admin` would be the second copy this seam exists to ban.

import type {
  DevPanel,
  DevSources,
  InvalidationFact,
  MailFact,
  ManifestFact,
  PolicyFact,
  RequestTrace,
  SqlResult,
} from '@ultimat3/admin/dev';
import { DEV_BASE_PATH, DEV_PANELS, defaultDevSources, devDashboard } from '@ultimat3/admin/dev';
import { recentInvalidations } from '@ultimat3/cache';
import type { Role } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { json as jsonResponse } from '@ultimat3/http';
import type { Manifest } from '@ultimat3/manifest';
import { checkAppBoundaries } from './app-boundaries';
import { appManifest, readAppManifest } from './app-manifest';
import { devPolicyMatrix } from './dev-policy';
import type { RunningServices } from './dev-runtime';
import type { DevServices } from './dev-services';
import type { TraceRecorder } from './dev-traces';
import type { Finding } from './output';

export interface DevStatus {
  readonly url: string;
  readonly services: DevServices;
  readonly roles: readonly Role[];
  readonly findings: readonly Finding[];
  readonly reloads: number;
}

export interface DevDashboardInput {
  readonly root: string;
  readonly runtime: RunningServices;
  /** Read at request time: the process's live facts change while the dashboard is mounted. */
  status(): DevStatus;
  /** NODE_ENV/X_ENV as x dev saw it; `devDashboard` refuses to mount in production. */
  readonly env?: string | undefined;
  /** The spans this process recorded. Absent when `x dev` did not install the exporter. */
  readonly traces?: TraceRecorder | undefined;
}

/**
 * Read-only is already enforced by `assertReadOnly` inside `dbPanel`, before `runSql` is ever
 * reached. A second gate here would be a second authz: two places to update when `x db psql
 * --write` changes what is allowed, and one of them would eventually disagree.
 */
async function runSql(input: DevDashboardInput, sql: string): Promise<SqlResult> {
  const started = performance.now();
  const rows = await input.runtime.db.query<Readonly<Record<string, unknown>>>({
    text: sql,
    values: [],
  });
  const elapsedMs = Math.round(performance.now() - started);
  // Columns come from the first row because the driver returns objects, not a described result
  // set; no rows means no columns to name, which the panel renders as an empty grid.
  const columns = Object.keys(rows[0] ?? {});
  return { columns, rows: rows.map((row) => columns.map((column) => row[column])), elapsedMs };
}

/** `MailMessage.locale` is non-optional in `@ultimat3/mail`, so the panel never has to guess. */
function mailFacts(input: DevDashboardInput): readonly MailFact[] {
  return input.runtime.mail.outbox().map((entry) => ({
    id: entry.result.id,
    to: entry.message.to.join(', '),
    subject: entry.message.subject,
    locale: entry.message.locale,
    html: entry.message.html,
    text: entry.message.text,
    sentAt: entry.at.toISOString(),
  }));
}

/** Top-level keys only: that is the granularity `manifestPanel` splits into added/removed/changed. */
const topLevel = (manifest: Manifest | undefined): ReadonlyMap<string, unknown> =>
  new Map<string, unknown>(manifest === undefined ? [] : Object.entries(manifest));

/**
 * A side that is missing stays `undefined` rather than becoming `null`: `manifestPanel` reads
 * exactly that distinction to tell an added key from a changed one.
 */
function manifestDiff(emitted: Manifest, committed: Manifest | undefined): ManifestFact['diff'] {
  const left = topLevel(emitted);
  const right = topLevel(committed);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key)))
    .map((key) => ({ path: key, emitted: left.get(key), committed: right.get(key) }));
}

async function manifestFact(root: string): Promise<ManifestFact> {
  const [{ manifest: emitted }, committed] = await Promise.all([
    appManifest(root),
    readAppManifest(root),
  ]);
  return { emitted, committed: committed ?? null, diff: manifestDiff(emitted, committed) };
}

/**
 * `@ultimat3/cache` keeps the report of every `invalidateTags` fan-out; the panel reads it back
 * as its log. Only the shape differs — the cache owns the facts, /_x owns the rendering.
 */
const invalidationFacts = (): readonly InvalidationFact[] =>
  recentInvalidations().map((event) => ({
    at: event.at,
    tags: event.tags,
    busted: event.busted,
    source: event.source,
  }));

/**
 * Every source only this process can answer. It owns the SQL connection, the caught outbox, the
 * committed manifest on disk, the span exporter and the app's registries — no other host can.
 *
 * `subscribers` is the one left unwired, and stays that way until `@ultimat3/realtime` records a
 * subscriber's matcher decision: `LiveSubscriberFact.trace` is the live panel's whole question,
 * and nothing in the registry retains it. `defaultDevSources` rejects it with `X_NOT_IMPLEMENTED`
 * and the wiring line, which the live panel degrades into its own `dev.live.no-sync-node` note —
 * a bare empty list would claim nobody is subscribed, which is a different and unearned answer.
 */
export function devSources(input: DevDashboardInput): DevSources {
  const traces = input.traces;
  return defaultDevSources({
    hooks: {
      runSql: (sql: string): Promise<SqlResult> => runSql(input, sql),
      mail: (): Promise<readonly MailFact[]> => Promise.resolve(mailFacts(input)),
      manifest: (): Promise<ManifestFact> => manifestFact(input.root),
      invalidations: (): Promise<readonly InvalidationFact[]> =>
        Promise.resolve(invalidationFacts()),
      // Read through the app's own policies at request time, so a reload that changes a rule
      // changes the matrix without a remount.
      policyMatrix: (): Promise<readonly PolicyFact[]> => Promise.resolve(devPolicyMatrix()),
      // Spread, never passed as `undefined`: a host with no recorder must fall back to the
      // refusal `defaultDevSources` already carries, not to an empty timeline.
      ...(traces === undefined
        ? {}
        : { traces: (): Promise<readonly RequestTrace[]> => Promise.resolve(traces.traces()) }),
    },
  });
}

interface ServicesPanelData extends DevStatus {
  readonly stateDir: string;
}

/**
 * Both CLI panels ignore the `DevSources` argument, and must: these are facts about this
 * process — which port it bound, which roles it started, which files would not import — not
 * introspection of the app's registries. No registry could answer them.
 */
const servicesPanel = (input: DevDashboardInput): DevPanel<ServicesPanelData> => ({
  key: 'services',
  titleKey: 'dev.panel.services',
  question: 'which services is this process talking to, and did anything fail to load?',
  data(): Promise<ServicesPanelData> {
    const status = input.status();
    return Promise.resolve({ ...status, stateDir: status.services.stateDir });
  },
});

interface BoundariesPanelData {
  readonly findings: readonly Finding[];
}

const boundariesPanel = (input: DevDashboardInput): DevPanel<BoundariesPanelData> => ({
  key: 'boundaries',
  titleKey: 'dev.panel.boundaries',
  question: 'does any file import across a boundary the build will reject?',
  async data(): Promise<BoundariesPanelData> {
    return { findings: await checkAppBoundaries(input.root) };
  },
});

export function devPanels(input: DevDashboardInput): readonly DevPanel[] {
  return [...DEV_PANELS, servicesPanel(input), boundariesPanel(input)];
}

/**
 * `handle` answers `null` only for a path outside `basePath`, and every path below was generated
 * from it — unreachable, answered anyway. A `!` here would turn a future `basePath` change into a
 * runtime crash instead of a payload that names the mismatch.
 */
const notClaimed = (path: string): Response =>
  jsonResponse(
    {
      panel: path,
      ok: false,
      error: {
        code: 'X_ROUTE_NOT_FOUND',
        cause: `x dev mounted ${path} but the /_x dashboard did not claim it`,
        fix: 'x dev --json   # then report the DEV_BASE_PATH / route table mismatch',
      },
    },
    { status: 404 },
  );

const devRoute = (path: string, name: string, handler: Route['handler']): Route => ({
  method: 'GET',
  path,
  // Public: /_x exists to be read without credentials by whatever drives the dev loop, and
  // `devDashboard` refuses to construct at all outside development.
  meta: { name, auth: 'public', tags: ['_x'] },
  handler,
});

/**
 * One route for the base path plus one per panel, because the router matches exact paths. The
 * dashboard is built once — its sources close over this process, and rebuilding per request would
 * re-run `assertDevOnly` on every hit for no new answer.
 */
export function devDashboardRoutes(input: DevDashboardInput): readonly Route[] {
  const panels = devPanels(input);
  const dashboard = devDashboard({
    basePath: DEV_BASE_PATH,
    panels,
    sources: devSources(input),
    ...(input.env === undefined ? {} : { env: input.env }),
  });

  const handler = async (request: UltimateRequest): Promise<Response> =>
    (await dashboard.handle(request.raw)) ?? notClaimed(request.pathname);

  return [
    devRoute(DEV_BASE_PATH, 'dev._x', handler),
    ...panels.map((panel) =>
      devRoute(`${DEV_BASE_PATH}/${panel.key}`, `dev._x.${panel.key}`, handler),
    ),
  ];
}
