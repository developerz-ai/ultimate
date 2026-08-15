// `x doctor` — everything that makes an environment lie to you, checked in one pass. Every finding
// carries the command that fixes it; a diagnostic that only describes a problem has handed the
// work back to the reader.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { usesDevCursorSecret } from '@ultimat3/core';
import { STORAGE_SIGNING_SECRET_KEY, usesDevStorageSecret } from '@ultimat3/storage';
import { findAppRoot, REQUIRED_BUN, versionAtLeast } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { ICON_SOURCE } from './dev-assets';
import { checkSourceDrift } from './drift';
import { intFlagOr, PORT_RANGE } from './flag-number';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';

/**
 * The injection seam `runDoctor` reads instead of the environment. Not a semver surface —
 * `wiki/Upgrading.md` covers `X_*` codes, the eight primitive shapes, the `x` CLI surface, the
 * tier table and `app.config.ts` fields, and not this — so a new fact the probe must report is a
 * REQUIRED field: an optional one lets an implementation skip the check and still typecheck.
 */
export interface DoctorProbe {
  readonly bunVersion: string;
  /** App root, or undefined when the command runs outside an app. */
  readonly root: string | undefined;
  readonly port: number;
  /** True while cursors are signed with the key shipped in the published package. */
  readonly devCursorSecret: boolean;
  /**
   * True while the local disk WOULD sign upload grants with the key shipped in the published
   * package. Same semantics as `devCursorSecret`, environment only — an app that passes an
   * explicit `signingSecret` in `app.config.ts` never consults the env var, so this can read true
   * for an app that is fine. The finding is worded as a condition to check, not a certainty.
   */
  readonly devStorageSecret: boolean;
  /** True when this process believes it is serving real clients. */
  readonly production: boolean;
  exists(relativePath: string): boolean;
  portFree(port: number): Promise<boolean>;
  drift(): Promise<readonly Finding[]>;
}

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

const finding = (code: string, cause: string, fix: string, at?: string): Finding =>
  at === undefined
    ? { code, cause, fix, docs: docs(code) }
    : { code, cause, fix, docs: docs(code), at };

export const OFFLINE_FALLBACK = 'apps/web/app/offline.tsx';

/** The port `x dev` binds by default, so the probe answers about the port the developer will use. */
const DEFAULT_DOCTOR_PORT = 3000;

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
  // Production only, and the gate is the point: every development environment signs with the
  // shipped key on purpose — that is what lets `x dev` page with no configuration — so an
  // unconditional finding would make `x doctor` red for every developer on day one and teach the
  // reader to skim past the report. The key is a defect only where cursors reach real clients,
  // who can read it out of the published package and forge a page position.
  // Sits here because it costs two env reads and a comparison — cheaper than binding a port.
  if (probe.production && probe.devCursorSecret) {
    findings.push(
      finding(
        'X_CURSOR_SECRET_DEV',
        'cursors are signed with the shipped development key, so a client can forge a page position',
        'export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"',
      ),
    );
  }
  // The storage twin of the cursor key above, and the more expensive one to get wrong: the
  // published string mints a signed `PUT` for any key with any `maxBytes` and `contentType`, and
  // `acceptSignedUpload` trusts the signed constraints over the app's own `uploadPolicy`.
  // Production only, for the reason the cursor check gives — every dev environment signs with the
  // shipped key on purpose. `@ultimat3/storage` refuses this at construction; `x doctor` is what
  // reports it before a deploy reaches the refusal.
  if (probe.production && probe.devStorageSecret) {
    findings.push(
      finding(
        'X_STORAGE_SECRET_DEV',
        `${STORAGE_SIGNING_SECRET_KEY} is unset or holds the shipped development key, so a local-disk deploy would accept forged upload grants that override its own uploadPolicy`,
        'export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
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
        // An edit naming the file, in `@ultimat3/pwa`'s own words (`requireSourceIcon`). Not
        // `x new`: it takes an app name and refuses to run inside the app that is missing the icon,
        // so offering it here hands the reader a command that cannot work where they are standing.
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
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
    devCursorSecret: usesDevCursorSecret(),
    devStorageSecret: usesDevStorageSecret(),
    // `X_ENV` first, then `NODE_ENV`: the order `@ultimat3/admin`'s dev-server guard already
    // reads them in, and a second order would be a second convention.
    production: (Bun.env['X_ENV'] ?? Bun.env['NODE_ENV']) === 'production',
    exists: (relativePath) => (root === undefined ? false : existsSync(join(root, relativePath))),
    portFree,
    drift: async () => (root === undefined ? [] : checkSourceDrift(root)),
  };
}

export const doctorCommand: CliCommand = {
  spec: {
    name: 'doctor',
    summary: 'environment, versions, drift, ports, PWA prerequisites — each with a fix command',
    usage: 'x doctor [--port 3000] [--json]',
    flags: [
      {
        name: 'port',
        type: 'string',
        summary: 'port to test',
        default: String(DEFAULT_DOCTOR_PORT),
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const port = intFlagOr(
      ctx.args,
      { name: 'port', command: 'doctor', ...PORT_RANGE, example: 'x doctor --port 3000' },
      DEFAULT_DOCTOR_PORT,
    );
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
