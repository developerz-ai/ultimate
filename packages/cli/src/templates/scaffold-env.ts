// The scaffolded app's environment, declared ONCE as a real `EnvSchema` and projected twice: into
// the `envSchema` export of `app.config.ts`, and into the `.env.example` committed beside it. A
// hand-written example file would be a second list of variable names, and `x new` would ship an
// app whose own `x verify` fails on the drift the framework exists to prevent.

import type { EnvSchema, EnvVarDecl } from '@ultimat3/core';
import { renderEnvExample } from '@ultimat3/core';

/**
 * Committed defaults only, so a fresh clone boots with `x dev` and no scavenger hunt. Every
 * description stays under ~80 characters: the serializer below indents them four spaces inside a
 * template Biome then checks at 100 columns, and a reflowed line is a failing `x verify` on file
 * one of a brand-new app.
 */
export const SCAFFOLD_ENV_SCHEMA = {
  DATABASE_URL: {
    type: 'url',
    required: false,
    description: 'Postgres URL. Empty means embedded: x dev runs PGlite in-process.',
  },
  PORT: {
    type: 'port',
    default: 3000,
    description: 'HTTP port this role binds. Every PaaS injects it.',
  },
  NATS_URL: {
    type: 'url',
    required: false,
    role: 'sync',
    description: 'Realtime fan-out cluster. Only the sync role is asked for it.',
  },
  SESSION_SECRET: {
    type: 'string',
    required: false,
    secret: true,
    description: 'Session cookie signing key. Generate: openssl rand -hex 32',
  },
} satisfies EnvSchema;

const quoted = (value: string): string => `'${value.replaceAll("'", "\\'")}'`;

/**
 * The value kinds an `EnvVarDecl` field can hold in a scaffold: a string, a number, a boolean, or
 * the string list `enum`'s `values` and a multi-role `role` use. `RegExp` (`pattern`) is
 * deliberately not one — its source would need re-escaping into a literal, and the scaffold has no
 * use for it. An unrenderable value is dropped rather than guessed at, so the projection stays
 * total and `envSchemaSource` can never emit `[object Object]` into a generated app.
 */
const literal = (value: unknown): string | undefined => {
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return `[${value.map(quoted).join(', ')}]`;
  }
  return undefined;
};

/**
 * The declaration as Biome-clean TypeScript. Always multi-line — Biome, like Prettier, keeps an
 * object expanded when the source has a newline after its `{`, so the emitted text is a fixed
 * point of the formatter and `x new` → `x verify` never fails on its own scaffold's layout.
 */
export function envSchemaSource(schema: EnvSchema = SCAFFOLD_ENV_SCHEMA): string {
  // Biome prints an empty object inline no matter what the source did, so the empty case is
  // emitted the way the formatter would rewrite it — otherwise the scaffold's own `lint` step
  // would fail on a file the scaffold wrote.
  if (Object.keys(schema).length === 0) return 'export const envSchema = {} satisfies EnvSchema;';
  const lines = ['export const envSchema = {'];
  for (const [key, decl] of Object.entries(schema)) {
    lines.push(`  ${key}: {`);
    for (const [prop, value] of Object.entries(decl)) {
      const rendered = literal(value);
      if (rendered !== undefined) lines.push(`    ${prop}: ${rendered},`);
    }
    lines.push('  },');
  }
  lines.push('} satisfies EnvSchema;');
  return lines.join('\n');
}

/** Byte-identical to what `x env example` writes, because both call core's one renderer. */
export const envExampleSource = (schema: EnvSchema = SCAFFOLD_ENV_SCHEMA): string =>
  renderEnvExample(schema);

/** Named so a reader of `repoFiles` can see the two projections come from one declaration. */
export const scaffoldEnvVarNames = (): readonly string[] =>
  Object.keys(SCAFFOLD_ENV_SCHEMA as Readonly<Record<string, EnvVarDecl>>);
