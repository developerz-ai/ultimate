// The two edits `x g sign-in` makes to the app's `app.config.ts`: `auth.signInPath`, so a 401 page
// links to the page it wrote, and — for an OIDC sign-in — the issuer and client keys declared in
// `envSchema`, so `x env example` lists them. Text edits at anchors `x new` writes; a file reshaped
// past them gets a finding with the exact lines, never a guess.

import { ERROR_DOCS_URL, stripComments } from '@ultimat3/core';
import type { Finding } from './output';

export const APP_CONFIG = 'app.config.ts';

/** One env key the sign-in needs, as `envSchema` declares it. */
export interface SignInEnvKey {
  readonly key: string;
  readonly description: string;
  readonly secret?: boolean;
  readonly type?: 'string' | 'url';
}

export interface ConfigEdit {
  readonly contents: string;
  readonly findings: readonly Finding[];
}

/** `lines` is code to paste — the fix opens with it, and says where after a `#`. */
const unplaced = (what: string, lines: string): Finding => ({
  code: 'X_GENERATE_CONFLICT',
  cause: `${APP_CONFIG} has no ${what} where x new writes one, so x g sign-in did not edit it`,
  fix: `${lines}   # paste into ${what} in ${APP_CONFIG}`,
  docs: ERROR_DOCS_URL,
  at: APP_CONFIG,
});

const SIGN_IN_PATH_LINE = (path: string): string => `auth: { signInPath: '${path}' },`;

/**
 * `auth: { signInPath }` after the config's `name:` line, unless a sign-in path is declared. Both
 * tests read the code with its comments blanked: a `// signInPath: …` the author parked declares
 * nothing, and skipping the edit over it left a 401 page linking nowhere.
 */
function withSignInPath(source: string, path: string): ConfigEdit {
  const code = stripComments(source);
  if (/\bsignInPath\s*:/.test(code)) return { contents: source, findings: [] };
  const anchor = /(export const config = defineConfig\(\{\n(\s*)name: [^\n]*\n)/.exec(source);
  if (anchor === null || /\n\s*auth:\s*\{/.test(code)) {
    return {
      contents: source,
      findings: [unplaced('defineConfig({ … })', SIGN_IN_PATH_LINE(path))],
    };
  }
  const indent = anchor[2] ?? '  ';
  const line = `${indent}// The page a refused browser is sent to: x g sign-in wrote it.\n${indent}${SIGN_IN_PATH_LINE(path)}\n`;
  const at = anchor.index + (anchor[1] ?? '').length;
  return { contents: `${source.slice(0, at)}${line}${source.slice(at)}`, findings: [] };
}

const envEntry = (entry: SignInEnvKey): string =>
  [
    `  ${entry.key}: {`,
    `    type: '${entry.type ?? 'string'}',`,
    '    required: false,',
    "    role: ['web', 'sync'],",
    ...(entry.secret === true ? ['    secret: true,'] : []),
    // Descriptions are this generator's own constants, written without a quote.
    `    description: '${entry.description}',`,
    '  },',
  ].join('\n');

/** Each key `envSchema` does not already declare, before its closing `} satisfies EnvSchema;`. */
function withEnvKeys(source: string, keys: readonly SignInEnvKey[]): ConfigEdit {
  const missing = keys.filter((entry) => !new RegExp(`\\n\\s*${entry.key}\\s*:`).test(source));
  if (missing.length === 0) return { contents: source, findings: [] };
  const close = source.indexOf('\n} satisfies EnvSchema;');
  if (close === -1) {
    return {
      contents: source,
      findings: [
        unplaced(
          'the envSchema object',
          `export const envSchema = { ${missing.map((entry) => `${entry.key}: { type: '${entry.type ?? 'string'}', required: false }`).join(', ')} }`,
        ),
      ],
    };
  }
  const block = missing.map(envEntry).join('\n');
  return {
    contents: `${source.slice(0, close)}\n${block}${source.slice(close)}`,
    findings: [],
  };
}

/** Both edits, in order, over the file's text as it stands. */
export function signInConfigEdit(
  source: string,
  signInPath: string,
  keys: readonly SignInEnvKey[],
): ConfigEdit {
  const pathed = withSignInPath(source, signInPath);
  const keyed = withEnvKeys(pathed.contents, keys);
  return { contents: keyed.contents, findings: [...pathed.findings, ...keyed.findings] };
}
