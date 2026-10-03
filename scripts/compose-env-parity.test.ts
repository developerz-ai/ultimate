// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture is COMPOSE TEXT — `${NAME:?…}`
// is Compose's interpolation, the very thing under test, and never a JavaScript template
//
// Single responsibility: every production compose file this repo ships — the framework's, both
// tracked apps' and the one `x new` writes — REQUIRES the same environment on the same role, so a
// tracked copy cannot drop the `${APP_URL:?…}` that stops a deploy whose sockets every page would
// be refused on. `compose-parity.test.ts` reads topology; this file reads environment.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { planNewApp } from '@ultimat3/cli';
import { YAML } from 'bun';
import { APP_ROOTS } from './boundaries';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const COMPOSE_FILE = 'docker/docker-compose.prod.yml';

type Required = ReadonlyMap<string, ReadonlySet<string>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The environment's values, in either legal shape: `{ KEY: v }` or `[KEY=v]`. */
const envValues = (environment: unknown): readonly [string, string][] => {
  if (isRecord(environment)) {
    return Object.entries(environment).map(([key, value]) => [key, String(value)]);
  }
  if (!Array.isArray(environment)) return [];
  return environment
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => [entry.split('=')[0] ?? '', entry.slice(entry.indexOf('=') + 1)]);
};

/**
 * Role → the variables its environment refuses to start without. Roles are the services carrying
 * `ROLE` (infrastructure like `db` is each file's own business), and "requires" is Compose's
 * `${NAME:?message}` — a default (`:-`) is not. Parity, not a list: a variable one file requires on
 * a role, every file with that role requires too.
 */
function requiredByRole(source: string): Required {
  const document: unknown = YAML.parse(source);
  const services = isRecord(document) ? document['services'] : undefined;
  const out = new Map<string, Set<string>>();
  for (const service of Object.values(isRecord(services) ? services : {})) {
    if (!isRecord(service)) continue;
    const env = envValues(service['environment']);
    const role = env.find(([key]) => key === 'ROLE')?.[1];
    if (role === undefined) continue;
    const needs = new Set<string>();
    for (const [, value] of env) {
      for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)) needs.add(match[1] ?? '');
    }
    out.set(role, needs);
  }
  return out;
}

/** `file: role lacks VAR (required by other)`, for every role two files share and disagree on. */
function parityGaps(files: ReadonlyMap<string, Required>): readonly string[] {
  const gaps: string[] = [];
  for (const [at, roles] of files) {
    for (const [other, otherRoles] of files) {
      for (const [role, needs] of otherRoles) {
        const mine = roles.get(role);
        if (mine === undefined) continue;
        for (const name of needs) {
          if (!mine.has(name))
            gaps.push(`${at}: ${role} lacks \${${name}:?…} (required by ${other})`);
        }
      }
    }
  }
  return [...new Set(gaps)].sort();
}

const ROLE_FILE = (web: string, sync: string): string =>
  [
    'services:',
    '  web:',
    `    environment: [ROLE=web${web}]`,
    '  sync:',
    `    environment: { ROLE: sync${sync} }`,
    '  db:',
    "    environment: ['POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?set it}']",
  ].join('\n');

describe('the rule', () => {
  test('reads both environment shapes, only `:?`, and only services with a ROLE', () => {
    const roles = requiredByRole(
      ROLE_FILE(
        ", 'SYNC_URL=${SYNC_URL:?set it}', 'LOG=${LOG:-info}'",
        ", APP_URL: '${APP_URL:?x}'",
      ),
    );
    expect([...roles.keys()].sort()).toEqual(['sync', 'web']);
    expect([...(roles.get('web') ?? [])]).toEqual(['SYNC_URL']);
    expect([...(roles.get('sync') ?? [])]).toEqual(['APP_URL']);
  });

  test('a role that drops a variable another file requires on it is a gap', () => {
    const full = requiredByRole(ROLE_FILE('', ", APP_URL: '${APP_URL:?x}'"));
    const dropped = requiredByRole(ROLE_FILE('', ''));
    expect(
      parityGaps(
        new Map([
          ['a.yml', full],
          ['b.yml', dropped],
        ]),
      ),
    ).toEqual(['b.yml: sync lacks ${APP_URL:?…} (required by a.yml)']);
  });
});

describe('every production compose file requires the same environment per role', () => {
  const root = repoRoot();
  const tracked = [COMPOSE_FILE, `${APP_ROOTS}/*/${COMPOSE_FILE}`]
    .flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: root })])
    .sort();

  test('across the framework file, both tracked apps and the scaffold', async () => {
    const files = new Map<string, Required>();
    for (const at of tracked) files.set(at, requiredByRole(await Bun.file(`${root}/${at}`).text()));
    const scaffold = planNewApp({ name: 'probe', example: true }).find(
      (file) => file.path === COMPOSE_FILE,
    )?.contents;
    expect(typeof scaffold, `x new writes no ${COMPOSE_FILE}, or writes it as bytes`).toBe(
      'string',
    );
    files.set(`x new → ${COMPOSE_FILE}`, requiredByRole(String(scaffold)));

    // Non-vacuity: four files, and the two origins every one of them must refuse to start without.
    expect(files.size).toBeGreaterThanOrEqual(4);
    for (const [at, roles] of files) {
      expect(roles.get('sync')?.has('APP_URL'), `${at}: sync does not require APP_URL`).toBe(true);
      expect(roles.get('web')?.has('SYNC_URL'), `${at}: web does not require SYNC_URL`).toBe(true);
    }
    expect(parityGaps(files)).toEqual([]);
  });
});
