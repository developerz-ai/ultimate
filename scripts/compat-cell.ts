// One compat cell, prepared: what the runtime under test needs changed before the gate's part runs
// on it. A Postgres cell writes a compose override retagging the test services' three Postgres
// images to its major — the base file stays digest-pinned and untouched; a Solid cell pins the
// newest 1.x by `overrides` and proves it installed; a Bun cell changes nothing (the workflow chose it).

import { renderFixShellArg } from '../packages/core/src/error-render';
import type { CompatCell } from './compat-cells';
import { jsonDocument } from './lib/health-narrow';
import type { Finding } from './lib/log';
import type { RunResult } from './lib/run';
import { LONG_RUN_TIMEOUT_MS, run } from './lib/run';
import { ScriptError } from './lib/script-error';

const COMPOSE = 'docker/docker-compose.test.yml';
/** The services one Postgres major must move together: the standby replays the primary's WAL. */
const PG_SERVICES = ['postgres', 'postgres-standby', 'postgres-tls'] as const;
/** Where the tmpfs is. Postgres 18's image defaults PGDATA under `/var/lib/postgresql/18/` and
 * refuses to start beside an unused mount here, so the cell names it — 16 and 17 already use it. */
const PGDATA = '/var/lib/postgresql/data';

export type Runner = (command: readonly string[], cwd: string) => Promise<RunResult>;

export interface Prepared {
  readonly ok: boolean;
  readonly summary: string;
  readonly findings: readonly Finding[];
}

interface ServiceOverride {
  readonly image: string;
  readonly environment?: { readonly PGDATA: string };
}

export interface ComposeOverride {
  readonly services: Readonly<Record<string, ServiceOverride>>;
}

const unprepared = (cause: string, fix: string): ScriptError =>
  new ScriptError({ code: 'X_COMPAT_CELL_UNPREPARED', cause, fix });

/** `name:tag@sha256:…` → `name:<tag with its major moved>`; a tag with no major is refused. */
const retag = (service: string, image: string, major: string): string => {
  const [name, tag] = (image.split('@')[0] ?? '').split(':');
  const moved = /^(pg)?\d+(-alpine)?$/.test(tag ?? '') ? tag?.replace(/\d+/, major) : undefined;
  if (name === undefined || moved === undefined) {
    throw unprepared(
      `${COMPOSE}'s ${service} image "${image}" carries no Postgres major in its tag, so no cell can move it`,
      `grep -n 'image:' ${COMPOSE}   # tag each Postgres image by its major: pgvector/pgvector:pg17, postgres:17-alpine`,
    );
  }
  return `${name}:${moved}`;
};

/** The override that runs the test services' Postgres at `major`, read off the base file's images. */
export function composeOverride(baseText: string, major: string): ComposeOverride {
  const base = Bun.YAML.parse(baseText) as {
    readonly services?: Readonly<Record<string, { readonly image?: unknown }>>;
  };
  const services: Record<string, ServiceOverride> = {};
  for (const service of PG_SERVICES) {
    const image = base.services?.[service]?.image;
    const tagged = retag(service, typeof image === 'string' ? image : '', major);
    services[service] =
      service === 'postgres-standby'
        ? { image: tagged }
        : { image: tagged, environment: { PGDATA } };
  }
  return { services };
}

/** The newest stable `<major>.x.y` of a registry's version list, or undefined when none is. */
export function newestOf(versions: readonly unknown[], major: string): string | undefined {
  const stable = versions.filter(
    (one): one is string =>
      typeof one === 'string' && new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(one),
  );
  return stable.sort((a, b) => Bun.semver.order(a, b)).at(-1);
}

/** The root manifest with `overrides["solid-js"]` pinned — Bun applies it to every workspace. */
export function withSolidOverride(manifestText: string, version: string): string {
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const overrides = manifest['overrides'];
  const kept = overrides !== null && typeof overrides === 'object' ? overrides : {};
  manifest['overrides'] = { ...kept, 'solid-js': version };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const spawn: Runner = (command, cwd) => run(command, { cwd, timeoutMs: LONG_RUN_TIMEOUT_MS });

async function prepareSolid(root: string, major: string, runner: Runner): Promise<string> {
  const view = await runner(['bun', 'pm', 'view', 'solid-js', 'versions', '--json'], root);
  const listed = jsonDocument(view.output);
  const version = Array.isArray(listed) ? newestOf(listed, major) : undefined;
  if (!view.ok || version === undefined) {
    throw unprepared(
      `the registry named no stable solid-js ${major}.x: ${view.output.trim().slice(0, 300) || `exit ${view.code}`}`,
      'bun pm view solid-js versions --json',
    );
  }
  const manifest = Bun.file(`${root}/package.json`);
  await Bun.write(manifest, withSolidOverride(await manifest.text(), version));
  // No lifecycle scripts: the cell resolves an unlocked solid-js, and nothing it tests needs one —
  // an upstream compromise must not run code in a default-branch job (security review of 8a).
  const install = await runner(['bun', 'install', '--ignore-scripts'], root);
  const installed = await Bun.file(`${root}/node_modules/solid-js/package.json`)
    .json()
    .then((doc: unknown) => (doc as { version?: unknown } | null)?.version)
    .catch(() => undefined);
  if (!install.ok || installed !== version) {
    throw unprepared(
      `solid-js ${version} was pinned and the install left ${String(installed ?? 'nothing')} (bun install ${install.ok ? 'passed' : `exited ${install.code}`})`,
      `bun install && grep '"version"' node_modules/solid-js/package.json   # expect ${version}`,
    );
  }
  return `solid-js ${version} installed over the pin`;
}

/** Make the checkout at `root` the cell's runtime; refusals come back as findings, never thrown. */
export async function prepareCell(input: {
  readonly root: string;
  readonly cell: CompatCell;
  readonly composeOut?: string;
  readonly runner?: Runner;
}): Promise<Prepared> {
  const { root, cell } = input;
  try {
    if (cell.axis === 'postgres') {
      if (input.composeOut === undefined) {
        throw unprepared(
          `${cell.id} needs a path to write its compose override to`,
          `bun run scripts/compat.ts prepare --cell ${renderFixShellArg(cell.id, '<cell>')} --compose-out /tmp/compat-compose.yml`,
        );
      }
      const override = composeOverride(await Bun.file(`${root}/${COMPOSE}`).text(), cell.version);
      await Bun.write(input.composeOut, `${JSON.stringify(override, null, 2)}\n`);
      return { ok: true, summary: `${cell.id}: compose override written`, findings: [] };
    }
    if (cell.axis === 'solid') {
      const said = await prepareSolid(root, cell.version, input.runner ?? spawn);
      return { ok: true, summary: `${cell.id}: ${said}`, findings: [] };
    }
    return { ok: true, summary: `${cell.id}: Bun ${Bun.version} (${Bun.revision})`, findings: [] };
  } catch (cause) {
    if (!(cause instanceof ScriptError)) throw cause;
    return { ok: false, summary: `${cell.id}: not prepared`, findings: [cause.toFinding()] };
  }
}
