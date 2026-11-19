// One `x doctor` check that throws costs that check, never the report. The whole command used to
// die as `X_CLI_UNEXPECTED`, whose fix is `x doctor --json`: the diagnostic told you to run itself.

import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import type { Finding } from './output';

export const probeFailedFinding = (check: string, error: unknown): Finding => ({
  code: 'X_DOCTOR_PROBE_FAILED',
  cause: `the ${check} check could not run: ${renderThrowable(error)}`,
  // `x manifest` loads the app the same way and names the module that fails.
  fix: 'bunx x manifest --json',
  docs: ERROR_DOCS_URL,
});

/** Runs `check`, recording a throw on `findings` as that check's own finding. */
export async function guardedCheck(
  name: string,
  findings: Finding[],
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
  } catch (error) {
    findings.push(probeFailedFinding(name, error));
  }
}

/** A listing beside the verdict: its value, or `otherwise` with the failure on `warnings`. */
export async function guardedListing<T>(
  name: string,
  warnings: Finding[],
  read: () => Promise<T>,
  otherwise: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    warnings.push(probeFailedFinding(name, error));
    return otherwise;
  }
}
