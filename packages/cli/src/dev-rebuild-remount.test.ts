// Which saves the process that built them cannot serve: `x dev` mounts its route table once, so a
// changed surface or a changed set of load findings is a restart, and an edited body is not. The
// restart line names its own cause and what moved.

import { describe, expect, test } from 'bun:test';
import type { Manifest } from '@ultimat3/manifest';
import type { Generation } from './dev-rebuild-remount';
import { remountFinding, remountLine, remountReason } from './dev-rebuild-remount';
import type { Finding } from './output';

const manifest = (overrides: Partial<Manifest> = {}): Manifest =>
  ({
    buildId: 'b1',
    routes: [{ url: '/hello', render: 'ssr', surface: 'app' }],
    actions: [{ name: 'publishPost' }],
    queries: [{ name: 'liveNotes' }],
    channels: [],
    jobs: [],
    ...overrides,
  }) as unknown as Manifest;

const FRESH = 'apps/web/app/fresh/page.tsx';
const broken: Finding = {
  code: 'X_CLI_UNEXPECTED',
  cause: 'BuildMessage: Unexpected =>',
  fix: 'x doctor --json',
  at: FRESH,
};

const generation = (over: Partial<Generation> = {}): Generation => ({
  manifest: manifest(),
  findings: [],
  ...over,
});

describe('remountReason', () => {
  test('an edited body — a new build id, the same surface — is served in place', () => {
    expect(
      remountReason(generation(), generation({ manifest: manifest({ buildId: 'b2' }) })),
    ).toBeUndefined();
  });

  test('a page the boot never mounted is a restart, naming the route', () => {
    const added = manifest({
      routes: [
        { url: '/hello', render: 'ssr', surface: 'app' },
        { url: '/fresh', render: 'ssr', surface: 'app' },
      ],
    });
    expect(remountReason(generation(), generation({ manifest: added }))).toEqual({
      kind: 'surface',
      added: ['route /fresh (ssr, app)'],
      removed: [],
    });
  });

  test('a removed action or query, and an added channel, are each named', () => {
    const before = generation();
    const channels = [{ name: 'feed' }] as unknown as Manifest['channels'];
    const after = generation({
      manifest: manifest({ actions: [], queries: [], channels } as Partial<Manifest>),
    });
    expect(remountReason(before, after)).toEqual({
      kind: 'surface',
      added: ['channel feed'],
      removed: ['action publishPost', 'query liveNotes'],
    });
  });

  test('a load finding that appears or clears is a restart; the same one, reordered, is not', () => {
    const other: Finding = { ...broken, at: 'apps/web/app/other/page.tsx' };
    expect(remountReason(generation(), generation({ findings: [broken] }))).toEqual({
      kind: 'findings',
      failing: [FRESH],
      loads: [],
    });
    expect(remountReason(generation({ findings: [broken] }), generation())).toEqual({
      kind: 'findings',
      failing: [],
      loads: [FRESH],
    });
    expect(
      remountReason(
        generation({ findings: [broken, other] }),
        generation({ findings: [other, broken] }),
      ),
    ).toBeUndefined();
  });
});

describe('remountLine', () => {
  test('a changed surface says what was added and removed, and that the table is built at boot', () => {
    const line = remountLine(
      { kind: 'surface', added: ['route /fresh (ssr, app)'], removed: ['query feed'] },
      FRESH,
    );
    expect(line).toBe(
      `restarting: ${FRESH} changed what x dev mounts (route /fresh (ssr, app) added, query feed removed) — the route table is built once, at boot`,
    );
    expect(line).not.toContain('defines a primitive');
  });

  test('a load finding says which module fails or loads again', () => {
    expect(remountLine({ kind: 'findings', failing: [], loads: [FRESH] }, FRESH)).toBe(
      `restarting: ${FRESH} changed which modules load (${FRESH} loads again) — the new process prints the verdict`,
    );
  });
});

describe('remountFinding', () => {
  test('names the save, what moved and the restart, at the saved file', () => {
    const finding = remountFinding(
      { kind: 'surface', added: ['route /fresh (ssr, app)'], removed: [] },
      FRESH,
    );
    expect(finding.code).toBe('X_DEV_RESTART_REQUIRED');
    expect(finding.cause).toContain('route /fresh (ssr, app) added');
    expect(finding.cause).toContain('404');
    expect(finding.fix).toBe('x stop && x dev');
    expect(finding.at).toBe(FRESH);
  });
});
