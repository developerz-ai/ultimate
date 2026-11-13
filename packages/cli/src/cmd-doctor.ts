// `x doctor` — everything that makes an environment lie to you, checked in one pass. Every finding
// carries the command that fixes it; a diagnostic that only describes a problem has handed the
// work back to the reader.

import { ENV_EXAMPLE_PATH, ERROR_DOCS_URL } from '@ultimat3/core';
import { REQUIRED_BUN, versionAtLeast } from './app-root';
import { doctorSpec } from './cmd-doctor-spec';
import type { CliCommand, CommandContext } from './command';
import { appUrlFindings } from './doctor-app-url';
import { authStorageFindings } from './doctor-auth';
import { chartAlertsProbe, NOTHING_MISSING, withChartAlertsListing } from './doctor-chart-alerts';
import { coverageExcludesProbe, withCoverageExcludes } from './doctor-coverage';
import { embeddedDatabaseFinding } from './doctor-database';
import { shippedGuardsProbe, withGuardListing } from './doctor-guards';
import { offlineFallbackFinding } from './doctor-offline';
import { NO_POOLER_FACT, poolerFindings, withPoolerReport } from './doctor-pooler';
import { doctorPort, portFindings } from './doctor-port';
import type { DoctorProbe } from './doctor-probe';
import { probeFor } from './doctor-probe';
import { rollingSinceProbe, withRollingReminder } from './doctor-rolling';
import { sealedKeyFindings } from './doctor-sealed';
import { typescriptFindings } from './doctor-typescript';
import { doctorWarnings, withDoctorWarnings } from './doctor-warnings';
import { ICON_SOURCE } from './icon-assets';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { quoteArg } from './shell-quote';

// `src/index.ts` publishes the seam from here; its declaration lives in `doctor-probe.ts`.
export type { DoctorProbe } from './doctor-probe';

const finding = (code: string, cause: string, fix: string, at?: string): Finding =>
  at === undefined
    ? { code, cause, fix, docs: ERROR_DOCS_URL }
    : { code, cause, fix, docs: ERROR_DOCS_URL, at };

/** The file `x doctor` reports missing, and the one the reader creates. */
export const ENV_DEVELOPMENT = '.env.development';

/**
 * Ordered cheapest-first so the first failure is usually the root cause: a wrong Bun explains
 * every other symptom, and running outside an app explains the rest.
 */
export async function runDoctor(probe: DoctorProbe): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  if (!versionAtLeast(probe.bunVersion, REQUIRED_BUN)) {
    findings.push(
      finding(
        'X_BUN_VERSION',
        `Bun ${probe.bunVersion} is older than the required ${REQUIRED_BUN}`,
        'bun upgrade',
      ),
    );
  }
  if (probe.root === undefined) {
    findings.push(
      // Not `x new`: outside an app `x` is on no PATH, and `bunx x` fetches an unrelated npm package.
      finding(
        'X_NOT_IN_APP',
        'no app.config.ts at or above the working directory',
        'bunx create-ultimate myapp && cd myapp',
      ),
    );
    return findings;
  }
  // Right after the runtime and for its reason: a compiler a major behind reds typecheck and build
  // on the framework's own files, and every finding below is read through a gate that cannot pass.
  findings.push(...typescriptFindings(await probe.typescript()));
  if (!probe.exists(ENV_DEVELOPMENT)) {
    findings.push(
      finding(
        'X_ENV_MISSING',
        `${ENV_DEVELOPMENT} is missing, so committed defaults cannot be read`,
        // The file write, named — `X_PWA_ICON_MISSING`'s shape below, and for its reason. This
        // said `x new --force`, which cannot run where the reader is standing: `x new` takes a
        // <name> positional (reproduced: `x new --force --json` inside an app answers
        // `X_CLI_BAD_FLAG`), and with one it scaffolds a SECOND app beside the broken one.
        // `.env.example` is the committed projection of `envSchema`, so the copy lands every
        // declared key with its default and blank secrets; `x env example` writes it where an app
        // has none, and `X_ENV_EXAMPLE_DRIFT` is what reports that.
        `cp ${quoteArg(ENV_EXAMPLE_PATH)} ${quoteArg(ENV_DEVELOPMENT)}`,
        ENV_DEVELOPMENT,
      ),
    );
  }
  // Silent in development and on a shell naming no environment; reported where this machine names
  // a deploy. One list, one wording (`framework-env.ts`, #679).
  findings.push(...probe.frameworkFindings);
  findings.push(...(await portFindings(probe)));
  findings.push(...appUrlFindings(probe.appUrl, probe.port));
  // `@ultimat3/pwa`'s own codes, not CLI twins of them. `X_PWA_NO_ICON_SOURCE` and
  // `X_PWA_NO_FALLBACK` used to be declared here for the same two conditions the package already
  // names — two codes for one condition, one of them registered by nobody, so `x errors explain`
  // answered for the package's and refused the CLI's.
  if (!probe.exists(ICON_SOURCE)) {
    findings.push(
      finding(
        'X_PWA_ICON_MISSING',
        `${ICON_SOURCE} is missing, so install icons and og images cannot be generated`,
        // An edit naming the file, in `@ultimat3/pwa`'s own words (`requireSourceIcon`). Not
        // `x new`: it takes an app name and refuses to run inside the app that is missing the icon,
        // so offering it here hands the reader a command that cannot work where they are standing.
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
        ICON_SOURCE,
      ),
    );
  }
  // The DECLARED fallback against the ROUTE TABLE, never a filename: this probed
  // `apps/web/app/offline.tsx`, which is not a route file at all (`assertRouteFilename` refuses
  // it), so no app could clear the finding and its own `fix:` did not either. `doctor-offline.ts`
  // holds the rule and the reasons.
  const offline = offlineFallbackFinding(await probe.offlineFallback());
  if (offline !== undefined) findings.push(offline);
  const pooler = await probe.pooler();
  findings.push(...poolerFindings(pooler));
  // A pooler's refusal is every other database probe's answer too, and its fix is the true one: this
  // one's says "set DATABASE_URL" to an operator whose URL is right.
  const database = pooler.refused === undefined ? await probe.database() : null;
  if (database !== null) findings.push(database);
  // The other half of the same question, and the half a bare VM lands on: `database()` is silent
  // where there is no `DATABASE_URL`, and that silence IS the bare-VM configuration.
  const embedded = embeddedDatabaseFinding(await probe.embeddedDatabase());
  if (embedded !== undefined) findings.push(embedded);
  // Asked only of a database that answered: an unreachable one is already the finding above.
  const reachable = pooler.refused === undefined && database === null;
  if (reachable) findings.push(...((await probe.rowSecurity?.()) ?? []));
  findings.push(...(await probe.drift()));
  // Last, and it is why `X_CLI_UNEXPECTED`'s `fix: x doctor --json` is not a dead end on the path an
  // author reaches it from: `x db gen` throwing `X_MIGRATION_SNAPSHOT_MISSING` used to be a
  // condition this diagnostic could not see at all, so the fix line ran clean over a broken app.
  findings.push(...(await probe.snapshots()));
  // Sealed columns against the key ring: no key at all, or a rotation whose re-seal is pending.
  findings.push(...sealedKeyFindings(await probe.sealedKeys()));
  findings.push(...authStorageFindings(await probe.authStorage()));
  // `X_FRAMEWORK_PIN_RANGE`, `X_ENV_NAME_RESERVED`, `X_DB_ROW_SECURITY_OFF` and
  // `X_VERIFY_STEP_UNFLOORED` are not here: on `main` they warn beside the verdict
  // (`doctor-warnings.ts`), so an upgrade with no change keeps this green.
  return findings;
}

/** The whole report over one probe: the verdict, then the listings and warnings beside it. */
export async function reportDoctor(probe: DoctorProbe): Promise<CommandResult> {
  // Asked once: `runDoctor` reads the verdict and the report beside it reads the numbers.
  const pooler = probe.root === undefined ? NO_POOLER_FACT : await probe.pooler();
  const findings = await runDoctor({ ...probe, pooler: async () => pooler });
  const listed = withGuardListing(
    {
      ok: findings.length === 0,
      command: 'doctor',
      summary:
        findings.length === 0
          ? msg('cli.doctor.clean')
          : msg('cli.doctor.findings', { count: findings.length }),
      findings,
      data: { count: findings.length, codes: findings.map((entry) => entry.code) },
    },
    // A listing beside the verdict, never part of it (`doctor-guards.ts` says why).
    probe.root === undefined ? [] : await shippedGuardsProbe(probe.root),
  );
  // The second listing: what the coverage floor does not see (`doctor-coverage.ts`).
  const covered = withCoverageExcludes(
    listed,
    probe.root === undefined ? [] : await coverageExcludesProbe(probe.root),
  );
  // The third: the monitoring templates and dashboard the chart predates (`doctor-chart-alerts.ts`).
  const charted = withChartAlertsListing(
    covered,
    probe.root === undefined ? NOTHING_MISSING : chartAlertsProbe(probe.root),
  );
  // A reminder, not a finding: the rolling rail is off until this is set (`doctor-rolling.ts`).
  const reminded = withPoolerReport(
    withRollingReminder(
      charted,
      probe.root === undefined ? undefined : await rollingSinceProbe(probe.root),
    ),
    pooler,
  );
  // Last, and beside the verdict on `main`: the 31.16.0 checks (`doctor-warnings.ts`).
  return withDoctorWarnings(reminded, await doctorWarnings(probe));
}

export const doctorCommand: CliCommand = {
  spec: doctorSpec,
  run(ctx: CommandContext): Promise<CommandResult> {
    const port = doctorPort(ctx.args, ctx.env);
    return reportDoctor(probeFor(ctx.cwd, ctx.bunVersion, port, ctx.env));
  },
};
