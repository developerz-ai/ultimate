// The shipped guards, run from the INSTALLED framework instead of from copies in the app: which
// ones run for this app, at what severity, and the module each is imported from. An app's
// `guards/` holds its own rules and `guards/shipped.json` — a severity per shipped guard, never a
// copy of one — so a fixed guard reaches every app on its next install, with no hand edit.

// why: Bun ships no path joiner; `guards/shipped.json` sits under the app root.
import { join } from 'node:path';
import { ERROR_DOCS_URL, isJsonObject } from '@ultimat3/core';
import { SHIPPED_GUARD_NAMES, type ShippedGuardName } from './guards-shipped-names';
import type { Finding } from './output';

/** The app's one file about shipped guards. Its presence is the opt-in: absent, an app is legacy. */
export const SHIPPED_GUARD_CONFIG = 'guards/shipped.json';

/** The key inside it. Named once: the problem quotes it and the fix repairs it. */
export const SHIPPED_SEVERITY_FIELD = 'severity';

/** Where a built-in guard says it lives, in a finding: the package that ships it, never the app. */
export const BUILT_IN_GUARD_PREFIX = '@ultimat3/cli/guards';

/** A vendored copy of a shipped guard. A string here until the coordinator registers it. */
export const GUARD_VENDORED_CODE = 'X_GUARD_VENDORED';

/** `"error"` gates, `"warning"` reports only, `"off"` does not run. Absent: the guard's own. */
export type ShippedSeverity = 'error' | 'warning' | 'off';
export type ShippedSeverities = Readonly<Record<string, ShippedSeverity>>;

const SEVERITIES: readonly string[] = ['error', 'warning', 'off'];

/**
 * `{ "severity": { "<shipped guard>": "error" | "warning" | "off" } }`, or the problems. A row
 * naming a guard the framework does not ship is a problem, never ignored: a typo covers nothing.
 */
export function parseShippedConfig(
  text: string,
  names: readonly string[] = SHIPPED_GUARD_NAMES,
): { readonly severity: ShippedSeverities; readonly problems: readonly string[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { severity: {}, problems: ['it does not parse as JSON'] };
  }
  if (!isJsonObject(payload)) return { severity: {}, problems: ['it is not a JSON object'] };
  const problems: string[] = Object.keys(payload)
    .filter((key) => key !== SHIPPED_SEVERITY_FIELD)
    .map((key) => `${JSON.stringify(key)} is not a key it reads — "${SHIPPED_SEVERITY_FIELD}" is`);
  const raw = payload[SHIPPED_SEVERITY_FIELD];
  if (raw === undefined) return { severity: {}, problems };
  if (!isJsonObject(raw)) {
    return {
      severity: {},
      problems: [...problems, `"${SHIPPED_SEVERITY_FIELD}" is not an object of guard → severity`],
    };
  }
  const severity: Record<string, ShippedSeverity> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!names.includes(name)) {
      problems.push(
        `"${SHIPPED_SEVERITY_FIELD}" names ${JSON.stringify(name)}, not a shipped guard`,
      );
    } else if (typeof value !== 'string' || !SEVERITIES.includes(value)) {
      problems.push(
        `"${SHIPPED_SEVERITY_FIELD}" gives ${name} ${JSON.stringify(value)}, not "error", "warning" or "off"`,
      );
    } else severity[name] = value as ShippedSeverity;
  }
  return { severity, problems };
}

/** The app's config; `severity` undefined when it has none — a legacy app, not yet migrated. */
export async function readShippedConfig(
  root: string,
): Promise<{ readonly severity?: ShippedSeverities; readonly problems: readonly string[] }> {
  const file = Bun.file(join(root, SHIPPED_GUARD_CONFIG));
  if (!(await file.exists())) return { problems: [] };
  return parseShippedConfig(await file.text());
}

/**
 * How a built-in runs. `default`: as the guard declares itself. `error`/`warning`: the app's row
 * over it. `legacy`: an app with no `guards/shipped.json` never had this guard gate it, so on
 * `main` everything it says — a broken finding too — is a warning, never red.
 */
export type BuiltInMode = 'default' | 'error' | 'warning' | 'legacy';

export interface BuiltInGuard {
  readonly name: ShippedGuardName;
  /** What a finding names as its source when the guard does not say: the package, not a file. */
  readonly display: string;
  readonly mode: BuiltInMode;
}

/** A shipped name's file in the app's own directory, `.ts` or `.tsx`, or undefined. */
export const vendoredPath = (paths: readonly string[], name: string): string | undefined =>
  paths.find((path) => path === `guards/${name}.ts` || path === `guards/${name}.tsx`);

/**
 * The rule, pure: every shipped guard this app runs built in, and the shipped names it holds a
 * copy of. A copy wins — the app's file runs in its place — so an app that has not upgraded keeps
 * exactly the rule it committed; the copy is reported (`vendoredWarning`) and never run twice.
 */
export function planBuiltIns(
  appPaths: readonly string[],
  severity: ShippedSeverities | undefined,
): { readonly builtIn: readonly BuiltInGuard[]; readonly vendored: readonly string[] } {
  const builtIn: BuiltInGuard[] = [];
  const vendored: string[] = [];
  for (const name of SHIPPED_GUARD_NAMES) {
    if (vendoredPath(appPaths, name) !== undefined) {
      vendored.push(name);
      continue;
    }
    const row =
      severity !== undefined && Object.hasOwn(severity, name) ? severity[name] : undefined;
    if (row === 'off') continue;
    const mode: BuiltInMode = severity === undefined ? 'legacy' : (row ?? 'default');
    builtIn.push({ name, display: `${BUILT_IN_GUARD_PREFIX}/${name}.ts`, mode });
  }
  return { builtIn, vendored };
}

/** The config's own problems: red, because a row the gate cannot read covers nothing. */
export const shippedConfigFindings = (problems: readonly string[]): readonly Finding[] =>
  problems.map((problem) => ({
    code: 'X_CONFIG_INVALID',
    cause: `${SHIPPED_GUARD_CONFIG} is not a shipped-guard config: ${problem}`,
    fix: `x verify --only boundaries --json   # then write ${SHIPPED_GUARD_CONFIG} as { "${SHIPPED_SEVERITY_FIELD}": { "<guard>": "off" } } — "error", "warning" or "off" per shipped guard: ${SHIPPED_GUARD_NAMES.join(', ')}`,
    docs: ERROR_DOCS_URL,
    at: SHIPPED_GUARD_CONFIG,
  }));
