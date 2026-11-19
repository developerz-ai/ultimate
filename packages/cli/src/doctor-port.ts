// `x doctor`'s port checks: both ports `x dev` binds, probed by role, and the one reading of which
// port that is (`--port`, then `PORT`, then 3000).

// why: Bun ships no realpath primitive.
import { realpathSync } from 'node:fs';
// why: Bun ships no path-separator primitive.
import { sep } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { freePortPair } from './dev-lock-free-port';
import type { PortOwner } from './dev-lock-holder-dir';
import { ownerText, portOwner } from './dev-lock-holder-dir';
import type { DoctorProbe } from './doctor-probe';
import { PORT_RANGE, readIntFlag } from './flag-number';
import type { Finding } from './output';
import { findingFrom } from './output';
import type { ParsedArgs } from './parse';
import { portFree } from './port-probe';
import { syncPortFor } from './role-sync';
import { portFromEnv } from './serve-env';
import { quoteArg } from './shell-quote';

const finding = (code: string, cause: string, fix: string): Finding => ({
  code,
  cause,
  fix,
  docs: ERROR_DOCS_URL,
});

export type PortProbe = Pick<DoctorProbe, 'port' | 'portFree' | 'root'> & {
  /** Who holds a port. Absent: the OS is asked, unless `portFree` is a test's stand-in. */
  readonly portOwner?: (port: number) => Promise<PortOwner>;
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Only a directory the OS named and that lies outside this app: unknown is never "not yours". */
function inAnotherCheckout(owner: PortOwner, root: string | undefined): boolean {
  if (owner.cwd === undefined || root === undefined) return false;
  const [dir, app] = [real(owner.cwd), real(root)];
  return dir !== app && !dir.startsWith(`${app}${sep}`);
}

/** A stand-in `portFree` describes an imagined machine; the real one has no say about it. */
const ownerLookup = (probe: PortProbe): ((port: number) => Promise<PortOwner>) =>
  probe.portOwner ?? (probe.portFree === portFree ? (port) => portOwner(port) : async () => ({}));

interface PortReport {
  readonly findings: readonly Finding[];
  readonly warnings: readonly Finding[];
}

/**
 * Both ports `x dev` binds, each labelled with the role that wants it. `x dev --port 3999` printed
 * `web listening on 3999`, then died on 4000 as `X_CLI_UNEXPECTED` with a caught `Error` rendered
 * into its cause — and `x doctor --port 3999` answered "no findings", because it probed the web
 * port and only the web port (#F5). The neighbouring port is not an implementation detail an
 * operator can ignore: `docker-compose.prod.yml` publishes `3001:3001` from it and `docker/helm`
 * derives `PORT = .port - 1` from it, so it is part of the contract `x dev` runs by.
 *
 * The suggested port moves BOTH: `x dev --port N` occupies N and N+1, so a free N beside a taken
 * N+1 is still not a runnable command. It did not move both until 2026-09 — the line was
 * `neighbouringPort(probe.port)`, which for the sync finding IS the port the finding is about, and
 * a docblock claiming otherwise is how it survived. `freePortPair` also asks that the pair is free:
 * beside two dev servers the next pair was often the second one's.
 *
 * A port held from ANOTHER checkout is a warning: a neighbour's dev server says nothing about this
 * environment, and it turned `x doctor` red in every other app on the machine.
 *
 * The sync port is `syncPortFor`, never `neighbouringPort` again: that helper answers 65534 for a
 * web port of 65535 — BELOW the web port, and a port `x dev` never binds — where the boot refuses
 * the run outright with `X_PORT_INVALID`. A probe that reports on a socket the command would never
 * open is answering a question nobody asked, so the boot's own rule decides, and its refusal is
 * reported instead of a probe. Alone, and ahead of the web port: there is no runnable `x dev` at
 * this port whatever the other one answers, and a second finding about it is noise over the cause.
 */
async function portReport(probe: PortProbe): Promise<PortReport> {
  let syncPort: number;
  try {
    syncPort = syncPortFor(probe.port);
  } catch (error) {
    // The boot's own error, carried whole — `findingFrom` reads its code, cause and fix off the
    // value rather than rendering it, which is what `scripts/catch-render.ts` requires.
    return { findings: [findingFrom(error)], warnings: [] };
  }
  const wanted = [
    { port: probe.port, role: 'web' },
    { port: syncPort, role: 'sync' },
  ] as const;
  const taken = [];
  for (const entry of wanted) if (!(await probe.portFree(entry.port))) taken.push(entry);
  if (taken.length === 0) return { findings: [], warnings: [] };
  const fix = `x dev --port ${quoteArg(String(await freePortPair(probe.port, probe.portFree)))}`;
  const lookup = ownerLookup(probe);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  for (const entry of taken) {
    const owner = await lookup(entry.port);
    const named = ownerText(owner);
    const need = `\`x dev --port ${probe.port}\` binds it for the ${entry.role} role`;
    if (inAnotherCheckout(owner, probe.root)) {
      const cause = `port ${entry.port} is held by ${named ?? 'another process'}, another checkout, and ${need} — nothing is wrong with this environment`;
      warnings.push(finding('X_PORT_IN_USE', cause, fix));
    } else {
      const held = named === undefined ? '' : ` (${named})`;
      const cause = `port ${entry.port} is already listening${held}, and ${need}`;
      findings.push(finding('X_PORT_IN_USE', cause, fix));
    }
  }
  return { findings, warnings };
}

/** The taken ports that are this environment's problem: `x doctor`'s verdict. */
export const portFindings = async (probe: PortProbe): Promise<readonly Finding[]> =>
  (await portReport(probe)).findings;

/** The taken ports another checkout holds: reported beside the verdict. */
export const portWarnings = async (probe: PortProbe): Promise<readonly Finding[]> =>
  (await portReport(probe)).warnings;

/**
 * The port to TEST, and the one place `x doctor` reads it: `devPortFor`'s order — `--port`, then
 * `PORT` (`portFromEnv`, the one reader of it), then 3000 — so the probe answers about the port
 * `x dev` will bind. It probed 3000 under `PORT=4000` while dev bound 4000 and 4001. `PORT_RANGE.min`
 * is 0 because `x dev --port 0` means "let the kernel pick"; here 0 means nothing, and
 * `Bun.serve({ port: 0 })` always succeeds — so the port check could not fail.
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
