// `x doctor` port parsing and socket checks. It shares `x dev`'s flag and sync-port rules so its
// diagnostics describe the complete pair of listeners the command would bind.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { DoctorProbe } from './doctor-probe-types';
import { PORT_RANGE, portPairAfter, readIntFlag } from './flag-number';
import type { Finding } from './output';
import { findingFrom } from './output';
import type { ParsedArgs } from './parse';
import { syncPortFor } from './role-sync';
import { portFromEnv } from './serve-env';
import { quoteArg } from './shell-quote';

/**
 * The port to TEST: --port, then PORT, then 3000, matching x dev. Unlike dev, 0 is not useful:
 * Bun.serve({ port: 0 }) always succeeds, so a probe asking the kernel to pick cannot fail.
 */
export const doctorPort = (
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
): number =>
  readIntFlag(args, {
    name: 'port',
    command: 'doctor',
    ...PORT_RANGE,
    min: 1,
    example: 'x doctor --port 3000',
  }) ?? portFromEnv(env);

/**
 * Both listeners x dev binds, labelled by role. The repair moves BOTH ports clear of the pair;
 * suggesting N+1 would leave the repaired web listener on the very sync port that failed.
 * syncPortFor owns the upper-bound refusal: 65535 has no sync port above it, and probing 65534
 * instead would judge a socket x dev never opens. Return that refusal alone, without probing.
 */
export async function portFindings(
  probe: Pick<DoctorProbe, 'port' | 'portFree'>,
): Promise<readonly Finding[]> {
  let syncPort: number;
  try {
    syncPort = syncPortFor(probe.port);
  } catch (error) {
    return [findingFrom(error)];
  }
  const wanted = [
    { port: probe.port, role: 'web' },
    { port: syncPort, role: 'sync' },
  ] as const;
  const findings: Finding[] = [];
  for (const entry of wanted) {
    if (await probe.portFree(entry.port)) continue;
    findings.push({
      code: 'X_PORT_IN_USE',
      cause: `port ${entry.port} is already listening, and \`x dev --port ${probe.port}\` binds it for the ${entry.role} role`,
      fix: `x dev --port ${quoteArg(String(portPairAfter(probe.port)))}`,
      docs: ERROR_DOCS_URL,
    });
  }
  return findings;
}
