// `x doctor`'s warnings: the 31.16.0 checks on how an app is held, reported BESIDE the verdict and
// never in it. On `main` an app that upgrades with no change keeps a green doctor
// (`X_BREAKING_ON_MAIN`); on `next` these move into `runDoctor`'s findings and the verdict.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { reservedEnvFindings } from './doctor-env-reserved';
import { unflooredStepFindings } from './doctor-floor';
import { pinRangeFindings } from './doctor-pins';
import { portWarnings } from './doctor-port';
import type { DoctorProbe } from './doctor-probe';
import { rowSecurityOffFindings } from './doctor-row-security';
import { REGISTRY_DRIVER } from './merge-driver-config';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';

const MERGE_DRIVER_UNSET: Finding = {
  code: 'X_MERGE_DRIVER_UNSET',
  cause: `.gitattributes names merge=${REGISTRY_DRIVER}, and this clone has no such driver, so two branches' generated features conflict`,
  fix: 'bunx x merge-driver install',
  docs: ERROR_DOCS_URL,
  at: '.gitattributes',
};

/** The probes that only warn on `main`. Asked inside an app only; outside one there is no app. */
export async function doctorWarnings(probe: DoctorProbe): Promise<readonly Finding[]> {
  if (probe.root === undefined) return [];
  return [
    // A ranged pin moves one package on the next install.
    ...pinRangeFindings(await probe.pins()),
    // An app's own name the framework reads too (`FRAMEWORK_ENV`).
    ...reservedEnvFindings(await probe.envNames()),
    // Static, so asked whatever the database answered: raw tenant SQL with the policy off.
    ...rowSecurityOffFindings(await probe.rowSecurityOff()),
    // A floor gap is the gate's blind spot, never a reason anything else is red.
    ...unflooredStepFindings(await probe.unflooredSteps()),
    // A clone that merges by hand what its drivers would have merged: slower, never wrong.
    ...((await probe.mergeDriverUnset?.()) === true ? [MERGE_DRIVER_UNSET] : []),
    // A port another checkout's dev server holds: nothing is wrong with this environment.
    ...(await portWarnings(probe)),
    // Served by the scan, so never refused: an action or query the typed client cannot see.
    ...((await probe.unlistedPrimitives?.()) ?? []),
  ];
}

const asJson = (warning: Finding): JsonValue => ({
  code: warning.code,
  cause: warning.cause,
  fix: warning.fix,
  ...(warning.docs === undefined ? {} : { docs: warning.docs }),
  ...(warning.at === undefined ? {} : { at: warning.at }),
});

/**
 * The warnings, on a result `x doctor` already decided: `data.warnings[]` (`{ code, cause, fix,
 * docs, at }`) for a machine, a line each for a person. `ok`, the summary and findings stay.
 */
export function withDoctorWarnings(
  result: CommandResult,
  warnings: readonly Finding[],
): CommandResult {
  if (warnings.length === 0) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), warnings: warnings.map(asJson) },
    lines: [
      ...(result.lines ?? []),
      msg('cli.doctor.warnings', { count: warnings.length }),
      ...warnings.map(({ code, cause, fix }) => msg('cli.doctor.warning', { code, cause, fix })),
    ],
  };
}
