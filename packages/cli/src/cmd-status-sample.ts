// `x status`'s origin half: `x deploy verify`'s own `/readyz` reader (`takeSample`) and origin
// check (`readOrigin`), folded into what answered — status, build header, role. No expectation,
// no wait: whether a build is fully out is `x deploy verify`'s question, and this only reports.

import { takeSample } from './cmd-deploy-verify-sample';
import { readOrigin } from './deploy-verify-flags';
import { UNREACHABLE } from './deploy-verify-grade';

/** One sample's own limit: a hung pod is one unreachable sample, never the whole read gone. */
const SAMPLE_TIMEOUT_MS = 10_000;

const ASKER = { command: 'status', example: 'x status --url https://app.example.com --json' };

/** `--url`'s one value, held to a bare http(s) origin by the reader `x deploy verify` uses. */
export const statusOrigin = (raw: string): string => readOrigin(raw, ASKER);

export interface OriginReport {
  readonly origin: string;
  readonly samples: number;
  /** Roles the answering processes named (a role health port does; the app's web port does not). */
  readonly roles: readonly string[];
  /** Defined with `Object.fromEntries`: a server names these keys, `__proto__` included. */
  readonly byBuild: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** 2xx answers that named no build: an image nobody stamped `BUILD_ID` into. */
  readonly unstamped: number;
}

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

/** `samples` reads, one after another, folded. Sequential: each is a fresh balancer choice. */
export async function sampleOrigin(origin: string, samples: number): Promise<OriginReport> {
  const byBuild = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const roles = new Set<string>();
  let unstamped = 0;
  for (let index = 0; index < samples; index += 1) {
    const answer = await takeSample(origin, SAMPLE_TIMEOUT_MS);
    bump(byStatus, answer.status === null ? UNREACHABLE : String(answer.status));
    if (answer.build !== null) bump(byBuild, answer.build);
    else if (is2xx(answer.status)) unstamped += 1;
    if (answer.role !== null) roles.add(answer.role);
  }
  return {
    origin,
    samples,
    roles: [...roles].sort(),
    byBuild: Object.fromEntries(byBuild),
    byStatus: Object.fromEntries(byStatus),
    unstamped,
  };
}
