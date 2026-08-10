// `x doctor` — everything that makes an environment lie to you, checked in one pass. Every finding
// carries the command that fixes it; a diagnostic that only describes a problem has handed the
// work back to the reader.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findAppRoot, REQUIRED_BUN, versionAtLeast } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { checkDrift } from './drift';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagString } from './parse';

export interface DoctorProbe {
  readonly bunVersion: string;
  /** App root, or undefined when the command runs outside an app. */
  readonly root: string | undefined;
  readonly port: number;
  exists(relativePath: string): boolean;
  portFree(port: number): Promise<boolean>;
  drift(): Promise<readonly Finding[]>;
}

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

const finding = (code: string, cause: string, fix: string, at?: string): Finding =>
  at === undefined
    ? { code, cause, fix, docs: docs(code) }
    : { code, cause, fix, docs: docs(code), at };

export const ICON_SOURCE = 'apps/web/site/icon.svg';
export const OFFLINE_FALLBACK = 'apps/web/app/offline.tsx';

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
      finding('X_NOT_IN_APP', 'no app.config.ts at or above the working directory', 'x new myapp'),
    );
    return findings;
  }
  if (!probe.exists('.env.development')) {
    findings.push(
      finding(
        'X_ENV_MISSING',
        '.env.development is missing, so committed defaults cannot be read',
        'x new --force to restore the committed defaults, or create .env.development',
        '.env.development',
      ),
    );
  }
  if (!(await probe.portFree(probe.port))) {
    findings.push(
      finding(
        'X_PORT_IN_USE',
        `port ${probe.port} is already listening`,
        `x dev --port ${probe.port + 1}`,
      ),
    );
  }
  // `@ultimat3/pwa`'s own codes, not CLI twins of them. `X_PWA_NO_ICON_SOURCE` and
  // `X_PWA_NO_FALLBACK` used to be declared here for the same two conditions the package already
  // names — two codes for one condition, one of them registered by nobody, so `x errors explain`
  // answered for the package's and refused the CLI's.
  if (!probe.exists(ICON_SOURCE)) {
    findings.push(
      finding(
        'X_PWA_ICON_MISSING',
        `${ICON_SOURCE} is missing, so install icons and og images cannot be generated`,
        `add a 1024px square ${ICON_SOURCE}, then run x manifest`,
        ICON_SOURCE,
      ),
    );
  }
  if (!probe.exists(OFFLINE_FALLBACK)) {
    findings.push(
      finding(
        'X_PWA_NO_OFFLINE_FALLBACK',
        `${OFFLINE_FALLBACK} is missing, so an offline navigation falls back to the browser error page`,
        'x g route offline --surface app',
        OFFLINE_FALLBACK,
      ),
    );
  }
  findings.push(...(await probe.drift()));
  return findings;
}

const portFree = async (port: number): Promise<boolean> => {
  try {
    const server = Bun.serve({ port, fetch: () => new Response('') });
    await server.stop(true);
    return true;
  } catch {
    return false;
  }
};

export function probeFor(cwd: string, bunVersion: string, port: number): DoctorProbe {
  const root = findAppRoot(cwd)?.dir;
  return {
    bunVersion,
    root,
    port,
    exists: (relativePath) => (root === undefined ? false : existsSync(join(root, relativePath))),
    portFree,
    drift: async () => (root === undefined ? [] : checkDrift(root)),
  };
}

export const doctorCommand: CliCommand = {
  spec: {
    name: 'doctor',
    summary: 'environment, versions, drift, ports, PWA prerequisites — each with a fix command',
    usage: 'x doctor [--port 3000] [--json]',
    flags: [{ name: 'port', type: 'string', summary: 'port to test', default: '3000' }],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const port = Number.parseInt(flagString(ctx.args, 'port') ?? '3000', 10);
    const findings = await runDoctor(probeFor(ctx.cwd, ctx.bunVersion, port));
    return {
      ok: findings.length === 0,
      command: 'doctor',
      summary:
        findings.length === 0
          ? msg('cli.doctor.clean')
          : msg('cli.doctor.findings', { count: findings.length }),
      findings,
      data: { count: findings.length, codes: findings.map((entry) => entry.code) },
    };
  },
};
