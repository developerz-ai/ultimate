// One step of an `x verify --json` part, read against the shape `mergeStep` relies on. It was a
// cast past `name` and `ok`: `findings: [null]` merged green, and a step with no `durationMs`
// reached `Math.max` as `undefined` — a part a CI job hand-edited, or truncated, was believed.

import type { Finding } from './output';
import type { TestCounts } from './test-counts';

export interface PartStep {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly skipped: boolean;
  readonly findings: readonly Finding[];
  readonly workers?: number;
  readonly tests?: TestCounts;
  readonly output?: string;
  readonly shard?: {
    readonly index: number;
    readonly total: number;
    readonly corpusHash: string;
    readonly files: readonly string[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** What every finding is: code, cause and fix as strings. Optional fields ride along as written. */
const isFinding = (value: unknown): value is Finding =>
  isRecord(value) &&
  typeof value['code'] === 'string' &&
  typeof value['cause'] === 'string' &&
  typeof value['fix'] === 'string';

const isTests = (value: unknown): value is TestCounts =>
  isRecord(value) &&
  isCount(value['ran']) &&
  isCount(value['skipped']) &&
  (value['errors'] === undefined || isCount(value['errors']));

const isShard = (value: unknown): value is NonNullable<PartStep['shard']> =>
  isRecord(value) &&
  isCount(value['index']) &&
  isCount(value['total']) &&
  typeof value['corpusHash'] === 'string' &&
  Array.isArray(value['files']) &&
  value['files'].every((file) => typeof file === 'string');

/** The step, or the reason it is not one — phrased to follow "holds a step …". */
export function readPartStep(raw: unknown): PartStep | string {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['ok'] !== 'boolean') {
    return 'holds a step without a name and ok';
  }
  const name = raw['name'];
  const durationMs = raw['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return `holds step "${name}" without a durationMs in milliseconds`;
  }
  const findings = raw['findings'];
  if (!Array.isArray(findings) || !findings.every(isFinding)) {
    return `holds step "${name}" whose findings are not each a code, a cause and a fix`;
  }
  const { tests, shard, output, workers, skipped } = raw;
  if (tests !== undefined && !isTests(tests)) {
    return `holds step "${name}" whose tests are not counts`;
  }
  if (shard !== undefined && !isShard(shard)) {
    return `holds step "${name}" whose shard is not an index, a total, a corpusHash and its files`;
  }
  if (output !== undefined && typeof output !== 'string') {
    return `holds step "${name}" whose output is not text`;
  }
  if (workers !== undefined && !isCount(workers)) {
    return `holds step "${name}" whose workers is not a count`;
  }
  return {
    name,
    ok: raw['ok'],
    durationMs,
    skipped: skipped === true,
    findings,
    ...(workers === undefined ? {} : { workers }),
    ...(tests === undefined ? {} : { tests }),
    ...(output === undefined ? {} : { output }),
    ...(shard === undefined ? {} : { shard }),
  };
}
