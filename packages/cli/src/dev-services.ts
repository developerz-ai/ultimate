// Service resolution for `x dev`. No Docker, no env scavenger hunt: an unset variable means the
// embedded default, and the resolved set is printed at boot so there is never a question about
// which database a running process is talking to.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type ServiceMode = 'embedded' | 'external';

export interface ServiceBinding {
  readonly name: 'db' | 'events' | 'storage';
  readonly mode: ServiceMode;
  readonly url: string;
  /** What the embedded default is, so `x doctor` can explain the difference. */
  readonly detail: string;
}

export interface DevServices {
  readonly db: ServiceBinding;
  readonly events: ServiceBinding;
  readonly storage: ServiceBinding;
  readonly stateDir: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value;

/**
 * Embedded Postgres is PGlite on disk under `.x/`, so a restart keeps the data and a `x db reset`
 * is a directory delete rather than a container dance.
 */
export function resolveServices(root: string, env: Env): DevServices {
  const stateDir = join(root, '.x');
  mkdirSync(stateDir, { recursive: true });
  const databaseUrl = nonEmpty(env['DATABASE_URL']);
  const natsUrl = nonEmpty(env['NATS_URL']);
  const s3Endpoint = nonEmpty(env['S3_ENDPOINT']);
  return {
    stateDir,
    db:
      databaseUrl === undefined
        ? {
            name: 'db',
            mode: 'embedded',
            url: `pglite://${join(stateDir, 'pgdata')}`,
            detail: 'PGlite in this process — set DATABASE_URL to use a real Postgres',
          }
        : { name: 'db', mode: 'external', url: databaseUrl, detail: 'DATABASE_URL' },
    events:
      natsUrl === undefined
        ? {
            name: 'events',
            mode: 'embedded',
            url: 'inproc://events',
            detail: 'in-process fanout — set NATS_URL to use NATS',
          }
        : { name: 'events', mode: 'external', url: natsUrl, detail: 'NATS_URL' },
    storage:
      s3Endpoint === undefined
        ? {
            name: 'storage',
            mode: 'embedded',
            url: `file://${join(stateDir, 'storage')}`,
            detail: 'local directory — set S3_ENDPOINT to use S3',
          }
        : { name: 'storage', mode: 'external', url: s3Endpoint, detail: 'S3_ENDPOINT' },
  };
}

export const ROLES = ['web', 'sync', 'worker', 'scheduler', 'replicator'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Role isolation, simulated. In production these are separate processes; in `x dev` they share
 * one, so the framework enforces the same boundary in-process — a web request that reaches worker
 * internals fails here exactly as it would fail over the network in production.
 */
export interface RoleContext {
  readonly role: Role;
  readonly allows: (other: Role) => boolean;
}

const ALLOWED: Record<Role, readonly Role[]> = {
  web: ['web'],
  sync: ['sync'],
  worker: ['worker'],
  scheduler: ['scheduler', 'worker'],
  replicator: ['replicator'],
};

export function roleContext(role: Role): RoleContext {
  return {
    role,
    allows: (other) => (ALLOWED[role] ?? []).includes(other),
  };
}

export const describeServices = (services: DevServices): string =>
  [services.db, services.events, services.storage]
    .map((binding) => `${binding.name}=${binding.mode}`)
    .join(' ');
