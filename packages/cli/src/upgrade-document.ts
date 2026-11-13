// The one JSON document on a child CLI's stdout, read as a foreign document: a hop's gate, the
// guards it installs and every caller that spawns an installed CLI share this one reading of it.

import { parseJson } from './upgrade-registry';

/**
 * Whole first; then its last line that parses, because the CLI that keeps fd 1 to one document
 * under `--json` is a recent one and a hop can install one that still logs a boot line ahead of it.
 */
export function documentIn(stdout: string): unknown {
  const whole = parseJson(stdout.trim());
  if (whole !== undefined) return whole;
  const lines = stdout.split('\n').filter((line) => line.trimStart().startsWith('{'));
  return lines
    .reverse()
    .map(parseJson)
    .find((parsed) => parsed !== undefined);
}
