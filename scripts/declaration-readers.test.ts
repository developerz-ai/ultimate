// The enforcement half of `scripts/declaration-readers.ts`: this file IS the build error. The
// gate's `unit` step runs every `scripts/**/*.test.ts`, so a declaration key that stops being read
// fails `bun run verify` with no extra wiring. The real repo is asserted NON-VACUOUSLY — a scan
// whose root regex stopped matching reports zero leaves, zero findings and the same green a
// truthful tree does, which is the one failure mode this rule cannot survive.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkDeclarationReaders,
  type DeclarationReaderGap,
  declarationReaderFindingFor,
  declarationReaderInput,
} from './declaration-readers';
import { DECLARATION_PINS_FILE, declarationReaderPinnedFor } from './lib/declaration-reader-pins';
import { declarationLeaves, interfaceTable } from './lib/declaration-scan';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();

const file = (path: string, text: string) => ({ path, text });

/** One declaration type, one factory that takes it, one reader — the shape every root has. */
const TREE = [
  file(
    'packages/render/src/route.ts',
    [
      'export interface RouteBudget {',
      '  readonly js?: string;',
      '  readonly cls?: number;',
      '}',
      'export interface RouteDefinition {',
      '  readonly budget?: RouteBudget;',
      '  readonly offline: string;',
      '}',
      'export function defineRoute(config: RouteDefinition): RouteDefinition {',
      '  return config;',
      '}',
    ].join('\n'),
  ),
  file(
    'packages/render/src/registry.ts',
    [
      'export const project = (entry) => ({',
      '  budgetJs: entry.config.budget.js ?? null,',
      '});',
    ].join('\n'),
  ),
  file('packages/cli/src/serve.ts', 'export const serve = (route) => route.offline;'),
];

describe('a declared key with no reader', () => {
  test('is reported, with the file that declares it and an edit that removes it', () => {
    const gaps = checkDeclarationReaders({
      leaves: declarationLeaves(TREE),
      files: TREE,
      pins: {},
    });

    expect(gaps.map((gap) => gap.leaf)).toEqual(['RouteDefinition.budget.cls']);
    const finding = declarationReaderFindingFor(gaps[0] as DeclarationReaderGap);
    expect(finding.code).toBe('X_DECLARED_KEY_UNREAD');
    expect(finding.at).toBe('packages/render/src/route.ts');
    expect(finding.fix).toContain(DECLARATION_PINS_FILE);
  });

  test('a key the declaring file itself consumes is READ — the factory sits beside its type', () => {
    // `defineStorage` reads `config.disks` in the same file `StorageConfig` is declared in. Counting
    // only OTHER files reported nine live keys as dead, which is a rule nobody would keep.
    const tree = [
      file(
        'packages/storage/src/storage.ts',
        [
          'export interface StorageConfig {',
          '  readonly disks: Record<string, string>;',
          '}',
          'export function defineStorage(config: StorageConfig): void {',
          '  register(config.disks);',
          '}',
        ].join('\n'),
      ),
    ];
    expect(
      checkDeclarationReaders({ leaves: declarationLeaves(tree), files: tree, pins: {} }),
    ).toEqual([]);
  });

  test('a pin with a real reason holds it, and a BLANK one does not', () => {
    const leaves = declarationLeaves(TREE);
    const held = checkDeclarationReaders({
      leaves,
      files: TREE,
      pins: { 'RouteDefinition.budget.cls': { reason: 'the lab measures it, not this repo' } },
    });
    expect(held).toEqual([]);

    const blank = checkDeclarationReaders({
      leaves,
      files: TREE,
      pins: { 'RouteDefinition.budget.cls': { reason: '  ' } },
    });
    expect(blank).toHaveLength(1);
    expect(declarationReaderFindingFor(blank[0] as DeclarationReaderGap).cause).toContain(
      'no reason',
    );
  });

  test('a pin whose key gained a reader, or whose key is gone, is stale in both directions', () => {
    const gained = checkDeclarationReaders({
      leaves: declarationLeaves(TREE),
      files: TREE,
      pins: { 'RouteDefinition.budget.js': { reason: 'nothing reads it' } },
    });
    // `budget.cls` is unread in this fixture on purpose, so the stale half is read off the
    // stale gaps alone — a filter, not a looser assertion.
    expect(gained.filter((gap) => gap.kind === 'stale').map((gap) => gap.stale)).toEqual([
      'now-read',
    ]);

    const deleted = checkDeclarationReaders({
      leaves: declarationLeaves(TREE),
      files: TREE,
      pins: { 'RouteDefinition.budget.inp': { reason: 'nothing reads it' } },
    });
    const stale = deleted.filter((gap) => gap.kind === 'stale');
    expect(stale.map((gap) => gap.stale)).toEqual(['key-deleted']);
    expect(declarationReaderFindingFor(stale[0] as DeclarationReaderGap).code).toBe(
      'X_DECLARATION_READER_PIN_STALE',
    );
  });
});

describe('what the walk reads', () => {
  test('a type name resolves inside its OWN package, never across the tree', () => {
    // Two packages declaring `RetryConfig` is ordinary. Resolving one against the other made
    // `JobDefinition.retry.*` read as `@ultimat3/ai`'s gateway options, so the leaves reported were
    // fields of an interface nothing in `@ultimat3/jobs` has ever declared.
    const tree = [
      file(
        'packages/jobs/src/job.ts',
        [
          'export interface RetryConfig {',
          '  readonly attempts?: number;',
          '}',
          'export interface JobDefinition {',
          '  readonly retry?: RetryConfig;',
          '}',
          'export function job(def: JobDefinition): JobDefinition {',
          '  return def;',
          '}',
        ].join('\n'),
      ),
      file(
        'packages/ai/src/gateway.ts',
        ['export interface RetryConfig {', '  readonly baseDelayMs?: number;', '}'].join('\n'),
      ),
    ];
    expect(declarationLeaves(tree).map((one) => one.leaf)).toEqual([
      'JobDefinition.retry.attempts',
    ]);
  });

  test('only a primitive or a define* factory opens a root', () => {
    const tree = [
      file(
        'packages/x/src/a.ts',
        [
          'export interface NotADeclaration {',
          '  readonly nobodyReadsThis?: string;',
          '}',
          'export function helper(input: NotADeclaration): void {}',
        ].join('\n'),
      ),
    ];
    expect(declarationLeaves(tree)).toEqual([]);
  });

  test('a name-first factory declares on its SECOND parameter', () => {
    const tree = [
      file(
        'packages/entity/src/entity.ts',
        [
          'export interface EntityInit {',
          '  readonly columns: string;',
          '}',
          'export function entity(name: string, init: EntityInit): EntityInit {',
          '  return init;',
          '}',
        ].join('\n'),
      ),
    ];
    expect(declarationLeaves(tree).map((one) => one.leaf)).toEqual(['EntityInit.columns']);
  });

  test('an interface table is keyed per package', () => {
    const table = interfaceTable(TREE);
    expect([...table.keys()]).toContain('render::RouteBudget');
  });
});

describe('this repository', () => {
  // One shared scan: reading every package's source once per test exceeded bun:test's 5s default
  // under the gate's parallel workers — green alone, red inside `x verify`. The timeout is a
  // deadlock backstop, never a performance assertion.
  const SCAN_TIMEOUT_MS = 60_000;
  let scan: ReturnType<typeof declarationReaderInput> | undefined;
  const input = () => (scan ??= declarationReaderInput(ROOT));

  test(
    'has no declaration key that nothing reads',
    async () => {
      expect(checkDeclarationReaders(await input())).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  test(
    'really walked the declarations — a root regex that stopped matching reports the same green',
    async () => {
      const { leaves } = await input();
      const roots = new Set(leaves.map((one) => one.root));
      // A FLOOR, and it may only rise: these are the primitive and `define*` declaration types this
      // rule exists to walk, and a scan that lost one of them is a scan that stopped enforcing.
      for (const root of [
        'ActionDef',
        'EntityInit',
        'HttpConfigInput',
        'JobDefinition',
        'QueryDef',
        'RouteDefinition',
        'StorageConfig',
        'TaskDefinition',
      ]) {
        expect(roots).toContain(root);
      }
      expect(leaves.length).toBeGreaterThan(120);
    },
    SCAN_TIMEOUT_MS,
  );

  test(
    'measures a key that IS read, so "read" is a measurement and not the default answer',
    async () => {
      const { leaves, files } = await input();
      const gaps = checkDeclarationReaders({
        leaves: leaves.filter((one) => one.leaf === 'RouteDefinition.budget.js'),
        files,
        pins: {},
      });
      expect(gaps).toEqual([]);
      // And the same key with nothing reading it is reported, over the SAME corpus.
      const invented = checkDeclarationReaders({
        leaves: [
          {
            root: 'RouteDefinition',
            leaf: 'RouteDefinition.budget.nobodyReadsThisKey',
            key: 'nobodyReadsThisKey',
            path: 'packages/render/src/route.ts',
            pkg: 'render',
          },
        ],
        files,
        pins: {},
      });
      expect(invented).toHaveLength(1);
    },
    SCAN_TIMEOUT_MS,
  );

  test('every pin carries a reason a human wrote', async () => {
    const { pins } = await input();
    for (const [leaf, pin] of Object.entries(pins)) {
      expect(`${leaf}: ${pin.reason.trim()}`.length).toBeGreaterThan(leaf.length + 40);
      expect(declarationReaderPinnedFor(leaf, pins)).toBe(true);
    }
  });
});
