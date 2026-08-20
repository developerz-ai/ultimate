// Single responsibility: `.env.example` is a PROJECTION of the `defineEnv()` schema, never a
// second hand-maintained list. Render it from the declarations, and report drift when the file on
// disk has fallen behind. Loading `.env` itself is Bun's job — see `envFileCandidates()`.

import type { EnvSchema, EnvVarDecl } from './env';
import { type CodedErrorInit, UltimateError } from './errors';

export class EnvExampleDriftError extends UltimateError {
  static readonly code = 'X_ENV_EXAMPLE_DRIFT';
  override readonly name = 'EnvExampleDriftError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: EnvExampleDriftError.code });
  }
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ENV_EXAMPLE_PATH = '.env.example';

/**
 * What Bun loads by itself, lowest precedence first — measured against Bun 1.3, not assumed.
 *
 * The mode is NOT `ULTIMATE_ENV` and not even `NODE_ENV` verbatim: Bun reads `.env.production`
 * for `NODE_ENV=production`, `.env.test` for `test`, and `.env.development` for **everything
 * else, `staging` included**. So a `.env.staging` file is never read, which is why a named
 * environment is carried by real environment variables (`ULTIMATE_ENV` plus the platform's own
 * config) and never by a per-environment dotenv file.
 */
export function envFileCandidates(nodeEnv?: string | undefined): readonly string[] {
  const mode = nodeEnv === 'production' || nodeEnv === 'test' ? nodeEnv : 'development';
  const files = ['.env', `.env.${mode}`];
  // Bun deliberately skips `.env.local` under test so a personal override cannot change a suite.
  return mode === 'test' ? files : [...files, '.env.local'];
}

function typeLabel(decl: EnvVarDecl): string {
  return decl.type === 'enum' ? decl.values.join(' | ') : decl.type;
}

function annotation(decl: EnvVarDecl): string {
  const parts = [decl.required === false ? 'optional' : 'required', typeLabel(decl)];
  if (decl.secret === true) parts.push('secret');
  if (decl.role !== undefined) {
    parts.push(`role ${(typeof decl.role === 'string' ? [decl.role] : decl.role).join('/')}`);
  }
  return parts.join(' · ');
}

/**
 * A secret never carries a value here even when the declaration has a default: this file is
 * committed, and a placeholder that happens to work is a credential nobody rotates.
 */
function exampleValue(decl: EnvVarDecl): string {
  if (decl.secret === true) return '';
  if (decl.default !== undefined) return String(decl.default);
  return decl.type === 'enum' ? (decl.values[0] ?? '') : '';
}

export interface EnvExampleOptions {
  /** Extra keys the app sets outside the schema (`ROLE`, `ULTIMATE_ENV`), rendered commented. */
  readonly extras?: readonly string[] | undefined;
}

/** Deterministic: declaration order in, declaration order out, so a rewrite diffs to nothing. */
export function renderEnvExample(schema: EnvSchema, options?: EnvExampleOptions): string {
  const lines = [
    '# Generated from defineEnv() — regenerate with `x env example`. Never hand-edited: drift',
    '# fails `x verify`.',
    '# Commit this file. Never commit .env: Bun loads .env, .env.<mode> and .env.local for you.',
  ];
  for (const [key, decl] of Object.entries(schema)) {
    lines.push('');
    if (decl.description !== undefined) lines.push(`# ${decl.description}`);
    lines.push(`# ${annotation(decl)}`);
    lines.push(`${key}=${exampleValue(decl)}`);
  }
  for (const extra of options?.extras ?? []) lines.push('', `# ${extra}=`);
  return `${lines.join('\n')}\n`;
}

/** Keys only — values in a dotenv file are Bun's to parse, and half of them are placeholders. */
export function parseEnvKeys(text: string): readonly string[] {
  const keys: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (ENV_KEY_RE.test(key)) keys.push(key);
  }
  return keys;
}

export interface EnvExampleReport {
  readonly ok: boolean;
  /** Declared in the schema, absent from the file. Always a defect. */
  readonly missing: readonly string[];
  /**
   * In the file, not in the schema — never fatal, because apps set keys nothing declares.
   *
   * NOT reported on its own, and the comment here said it was. `ok` is `missing.length === 0`, so
   * an example carrying only extra keys returns `ok: true` and `assertEnvExample` never builds an
   * error: the list reaches a surface only as `meta` on a drift some MISSING key already raised.
   * A caller that wants it reads `checkEnvExample(...).extra` itself, which is why this stays
   * public. `env-example.test.ts` pins both halves.
   */
  readonly extra: readonly string[];
}

export function checkEnvExample(schema: EnvSchema, text: string): EnvExampleReport {
  const declared = Object.keys(schema);
  const present = new Set(parseEnvKeys(text));
  const missing = declared.filter((key) => !present.has(key));
  const extra = [...present].filter((key) => !declared.includes(key));
  return { ok: missing.length === 0, missing, extra };
}

/**
 * Throws `X_ENV_EXAMPLE_DRIFT` when the committed example has fallen behind the schema — the
 * failure an agent hits *before* a teammate hits `X_ENV_MISSING` on a variable nobody told them
 * about.
 */
export function assertEnvExample(schema: EnvSchema, text: string, path = ENV_EXAMPLE_PATH): void {
  const report = checkEnvExample(schema, text);
  if (report.ok) return;
  throw new EnvExampleDriftError({
    cause: `${path} does not declare ${report.missing.join(', ')}, declared by defineEnv()`,
    fix: `Bun.write('${path}', renderEnvExample(schema)) — regenerate it from the declarations`,
    meta: { path, missing: report.missing, extra: report.extra },
  });
}
