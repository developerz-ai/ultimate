// The typed machine-fact seam shared by `x doctor` probing and ordered checks. Keeping it separate
// makes every diagnostic required without coupling its pure rules to command rendering.

import type { AuthStorageFact } from './doctor-auth';
import type { OfflineFallbackFact } from './doctor-offline';
import type { PoolerFact } from './doctor-pooler';
import type { SealedKeysFact } from './doctor-sealed';
import type { Finding } from './output';
import type { TypescriptLag } from './typescript-floor';

/** What `x doctor` reads about the embedded database without opening it. */
export interface EmbeddedDatabase {
  /** Unset or blank DATABASE_URL selects PGlite, matching resolveServices and probeDatabase. */
  readonly selected: boolean;
  /** The optional peer is installed above the app root (or cwd), without importing or opening it. */
  readonly resolved: boolean;
}

/** The complete injected machine seam used by the doctor check sequencer. */
export interface DoctorProbe {
  readonly bunVersion: string;
  readonly root: string | undefined;
  readonly port: number;
  readonly appUrl: string | undefined;
  readonly frameworkFindings: readonly Finding[];
  exists(relativePath: string): boolean;
  portFree(port: number): Promise<boolean>;
  /** External reachability only; null also means embedded, whose lock belongs to x dev. */
  database(): Promise<Finding | null>;
  embeddedDatabase(): Promise<EmbeddedDatabase>;
  drift(): Promise<readonly Finding[]>;
  snapshots(): Promise<readonly Finding[]>;
  offlineFallback(): Promise<OfflineFallbackFact>;
  sealedKeys(): Promise<SealedKeysFact>;
  authStorage(): Promise<AuthStorageFact>;
  pooler(): Promise<PoolerFact>;
  typescript(): Promise<readonly TypescriptLag[]>;
  /** Optional for existing injected probes; asked only after an external configuration is usable. */
  rowSecurity?(): Promise<readonly Finding[]>;
}
