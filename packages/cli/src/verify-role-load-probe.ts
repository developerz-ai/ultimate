// The child `verify-role-load.ts` spawns: `bun verify-role-load-probe.ts <app root>`. Imports what
// a worker imports, then every module that load left out — one at a time — and prints what each of
// those registered that the worker's process did not hold. Run by hand, it is the same answer.

import { scanAppModules } from './app-load';
import { scanBackground } from './role-load';
import type { MissingRegistration } from './verify-role-load';
import { PROBE_MARKER, registeredSince, registrations } from './verify-role-load';
import { writeLine } from './write-line';

/**
 * What importing each module the worker load left out registered, by module — `[]` when the whole
 * scan reported a module that would not import. Exported so a test calls it in its own process;
 * the gate runs it as a child, where the registries hold nothing the gate's own load put there.
 */
export async function probeRoleLoad(root: string): Promise<readonly MissingRegistration[]> {
  const background = await scanBackground(root);
  const imported = new Set(background.files);
  let held = registrations();
  const missing: MissingRegistration[] = [];
  let current: string | undefined;

  /** Whatever appeared since the last look was registered by importing `current`. */
  const attribute = (): void => {
    const now = registrations();
    if (current !== undefined) {
      for (const one of registeredSince(held, now)) missing.push({ ...one, module: current });
    }
    held = now;
  };

  // The whole app, in the scan's own order. `include` is asked before each import, so the look it
  // takes is at what the PREVIOUS module added; a module the worker already imported adds nothing.
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const whole = await scanAppModules(root, {
    track: false,
    include: (absolute) => {
      attribute();
      const file = absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
      current = imported.has(file) ? undefined : file;
      return true;
    },
  });
  attribute();
  // A module that would not import registered nothing in EITHER load, and the gate's own load
  // already reports it: an answer drawn from a short scan would blame the wrong thing.
  return whole.findings.length > 0 ? [] : missing;
}

if (import.meta.main) {
  const answer = await probeRoleLoad(process.argv[2] ?? process.cwd());
  writeLine(`${PROBE_MARKER}${JSON.stringify(answer)}`);
  process.exit(0);
}
