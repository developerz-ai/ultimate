// TEST-ONLY. The probe a `runDoctor` test edits one field of, and the codes it answers — shared by
// `cmd-doctor.test.ts` (the findings) and `cmd-doctor-probe.test.ts` (reading the real machine).

import { REQUIRED_BUN } from './app-root';
import type { DoctorProbe } from './cmd-doctor';
import { runDoctor } from './cmd-doctor';

export const probe = (over: Partial<DoctorProbe> = {}): DoctorProbe => ({
  bunVersion: REQUIRED_BUN,
  root: '/app',
  port: 3000,
  appUrl: undefined,
  // The ordinary developer: shipped keys in a development environment, so nothing is owed. Every
  // case below that does not say otherwise is this one.
  frameworkFindings: [],
  exists: () => true,
  portFree: async () => true,
  // Reachable, or embedded — the probe's own `null`. A test that opened a pool would be asking
  // about the box it runs on rather than about `runDoctor`.
  database: async () => null,
  // The bare VM that WORKS: no DATABASE_URL, and `bun install` put the optional peer in place.
  embeddedDatabase: async () => ({ selected: true, resolved: true }),
  drift: async () => [],
  snapshots: async () => [],
  // The app the scaffold writes: a declared fallback with a `site/` page answering it.
  offlineFallback: async () => ({
    fallback: '/offline',
    routes: [{ path: '/offline', surface: 'site' }],
  }),
  // The app the scaffold writes: no sealed column, so the key ring is never asked about.
  sealedKeys: async () => ({ columns: [], keys: undefined }),
  // A database with nothing left over from an upgrade.
  authStorage: async () => ({ unsealedMfaSecrets: 0, retiredTables: [] }),
  ...over,
});

export const codes = async (input: DoctorProbe): Promise<readonly string[]> =>
  (await runDoctor(input)).map((finding) => finding.code);
