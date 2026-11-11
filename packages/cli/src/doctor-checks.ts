// The ordered `x doctor` findings. This module sequences injected facts while concern modules own
// their individual rules, retaining cheap root-cause diagnostics and the outside-app early return.

import { ENV_EXAMPLE_PATH, ERROR_DOCS_URL } from '@ultimat3/core';
import { REQUIRED_BUN, versionAtLeast } from './app-root';
import { appUrlFindings } from './doctor-app-url';
import { authStorageFindings } from './doctor-auth';
import { embeddedDatabaseFinding } from './doctor-embedded';
import { offlineFallbackFinding } from './doctor-offline';
import { poolerFindings } from './doctor-pooler';
import { portFindings } from './doctor-ports';
import type { DoctorProbe } from './doctor-probe-types';
import { sealedKeyFindings } from './doctor-sealed';
import { typescriptFindings } from './doctor-typescript';
import { ICON_SOURCE } from './icon-assets';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

export const ENV_DEVELOPMENT = '.env.development';

const finding = (code: string, cause: string, fix: string, at?: string): Finding =>
  at === undefined
    ? { code, cause, fix, docs: ERROR_DOCS_URL }
    : { code, cause, fix, docs: ERROR_DOCS_URL, at };

/** Collects findings in stable order from a complete probe. */
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
      finding(
        'X_NOT_IN_APP',
        'no app.config.ts at or above the working directory',
        'bunx create-ultimate myapp && cd myapp',
      ),
    );
    return findings;
  }
  findings.push(...typescriptFindings(await probe.typescript()));
  if (!probe.exists(ENV_DEVELOPMENT)) {
    findings.push(
      finding(
        'X_ENV_MISSING',
        `${ENV_DEVELOPMENT} is missing, so committed defaults cannot be read`,
        `cp ${quoteArg(ENV_EXAMPLE_PATH)} ${quoteArg(ENV_DEVELOPMENT)}`,
        ENV_DEVELOPMENT,
      ),
    );
  }
  findings.push(...probe.frameworkFindings);
  findings.push(...(await portFindings(probe)));
  findings.push(...appUrlFindings(probe.appUrl, probe.port));
  if (!probe.exists(ICON_SOURCE)) {
    findings.push(
      finding(
        'X_PWA_ICON_MISSING',
        `${ICON_SOURCE} is missing, so install icons and og images cannot be generated`,
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
        ICON_SOURCE,
      ),
    );
  }
  const offline = offlineFallbackFinding(await probe.offlineFallback());
  if (offline !== undefined) findings.push(offline);
  const pooler = await probe.pooler();
  findings.push(...poolerFindings(pooler));
  const database = pooler.refused === undefined ? await probe.database() : null;
  if (database !== null) findings.push(database);
  const embedded = embeddedDatabaseFinding(await probe.embeddedDatabase());
  if (embedded !== undefined) findings.push(embedded);
  if (pooler.refused === undefined && database === null)
    findings.push(...((await probe.rowSecurity?.()) ?? []));
  findings.push(...(await probe.drift()));
  findings.push(...(await probe.snapshots()));
  findings.push(...sealedKeyFindings(await probe.sealedKeys()));
  findings.push(...authStorageFindings(await probe.authStorage()));
  return findings;
}
