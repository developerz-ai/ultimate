// The shape of `.github/workflows/compat.yml` that keeps the weekly matrix honest: off the gate, the
// gate's own `unit` and `live` split the gate's way with the services its parts start, a red part's
// exit kept (`pipefail`) and its document uploaded, each cell under its time budget, and
// `issues: write` held by the filing job alone. Reads the REAL workflows.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { COMPAT_WORKFLOW, readCompatMatrix } from './compat-cells';
import { expr, jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const raw = await Bun.file(`${repoRoot()}/${COMPAT_WORKFLOW}`).text();
const workflow = Bun.YAML.parse(raw) as {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: unknown;
};
const compat = await readWorkflow('compat.yml');
const cell = jobOf(compat, 'cell');
const file = jobOf(compat, 'file');
const matrix = readCompatMatrix(raw);
const NOT_CANCELLED = expr('!cancelled()');

/** The services and URLs `ci.yml`'s plan step hands a part, by its `needs` level. */
const planEnv = (await readWorkflow('ci.yml')).jobs?.['tested']?.steps?.find(
  (step) => step.id === 'plan',
)?.env;

describe('unit · compat.yml is weekly and never a gate', () => {
  test('a schedule and a manual dispatch, nothing a push or a PR starts', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  test('every cell runs every part, and one red cell never cancels the others', () => {
    expect(Object.keys(cell.strategy?.matrix ?? {}).sort()).toEqual(['cell', 'part']);
    expect(cell.strategy?.['fail-fast']).toBe(false);
  });

  test('each cell job fits the budget: a 15-minute kill switch, the spawn deadline under it', () => {
    expect(cell['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(file['timeout-minutes']).toBeLessThanOrEqual(10);
  });
});

describe('unit · compat.yml runs the gate’s parts, as the gate splits them', () => {
  test('unit and live only, each over every shard of one split', () => {
    for (const step of ['unit', 'live'] as const) {
      const shards = matrix.parts.filter((part) => part.only === step).map((part) => part.shard);
      const total = Number(shards[0]?.split('/')[1]);
      expect(shards.length, `${step} is not split`).toBeGreaterThan(0);
      expect(shards).toEqual(Array.from({ length: total }, (_, at) => `${at + 1}/${total}`));
    }
  });

  test('a part starts the services and exports the URLs its ci.yml part does', () => {
    const split = (value: unknown, by: string) => text(value).split(by).filter(Boolean);
    expect(planEnv).toBeDefined();
    for (const part of matrix.parts) {
      const level = part.only === 'unit' ? 'DATABASE' : 'ALL';
      expect(part.services, part.name).toEqual(split(planEnv?.[`${level}_SERVICES`], ' '));
      expect(part.urls, part.name).toEqual(split(planEnv?.[`${level}_URLS`], '|'));
    }
  });

  test('the part step is `compat.ts run` and keeps its exit through tee', () => {
    const step = cell.steps?.find((one) => one.run?.includes('scripts/compat.ts run'));
    expect(step?.shell).toBe('bash');
    expect(step?.run).toContain('set -o pipefail');
    expect(step?.run).toContain('--json');
  });

  test('a cell prepares before its services start, and the services read its override', () => {
    const steps = cell.steps ?? [];
    const prepare = steps.findIndex((one) => one.run?.includes('scripts/compat.ts prepare'));
    const services = steps.findIndex((one) => one.run?.includes('docker compose'));
    expect(prepare).toBeGreaterThan(-1);
    expect(services).toBeGreaterThan(prepare);
    expect(steps[services]?.run).toContain('compat-compose.yml');
    expect(steps[prepare]?.run).toContain('compat-compose.yml');
  });
});

describe('unit · compat.yml · a red part reaches the filing job', () => {
  test('the part document is uploaded after a red part, named by attempt, and filed', () => {
    const upload = cell.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe(NOT_CANCELLED);
    expect(text(upload?.with?.['name'])).toContain(expr('github.run_attempt'));
    expect(file.needs).toBe('cell');
    expect(file.if).toBe(NOT_CANCELLED);
    expect(file.steps?.some((step) => step.run?.includes('scripts/compat.ts file'))).toBe(true);
  });
});

describe('unit · compat.yml · least privilege', () => {
  test('read-only at the top; issues: write on the filing job alone', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(cell.permissions).toBeUndefined();
    expect(file.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  test('no job keeps its token in .git/config', () => {
    for (const job of [cell, file]) {
      const checkout = job.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.['persist-credentials']).toBe(false);
    }
  });
});
