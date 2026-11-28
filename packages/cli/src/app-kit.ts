// The agent kit against the app's disk: a managed file missing or edited is X_KIT_DRIFT, a command
// that a same-named skill silently shadows is X_KIT_SHADOWED. Pure over an injected reader, so the
// gate, `x kit`, `x doctor` and `x upgrade` all ask one function. `.claude/kit.json` is the opt-in:
// present, the findings are errors; absent, one warning — `main` never reddens on a new rule.

import { ERROR_DOCS_URL, isJsonObject, renderFixShellArg } from '@ultimat3/core';
import type { KitFile } from './kit/registry';
import { KIT_MARKER } from './kit/registry';
import type { Finding } from './output';

export const KIT_DRIFT = 'X_KIT_DRIFT';
export const KIT_SHADOWED = 'X_KIT_SHADOWED';
export const KIT_FIX = 'bunx x kit';
const COMMANDS_DIR = '.claude/commands';

/** What the app's disk answers: the text at a path, and the paths a glob names. */
export interface KitDisk {
  read(path: string): Promise<string | undefined>;
  glob(pattern: string): Promise<readonly string[]>;
}

export type KitMarker =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly why: string }
  | { readonly state: 'present'; readonly off: readonly string[] };

/** `kit.json` parsed: `{ "off": ["<entry name>", …] }`, the only key. */
export function parseKitMarker(text: string | undefined): KitMarker {
  if (text === undefined) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'invalid', why: 'it is not JSON' };
  }
  if (!isJsonObject(parsed)) return { state: 'invalid', why: 'it is not an object' };
  const off = parsed['off'];
  if (off === undefined) return { state: 'present', off: [] };
  if (!Array.isArray(off) || off.some((entry) => typeof entry !== 'string')) {
    return { state: 'invalid', why: '"off" is not a list of entry names' };
  }
  return { state: 'present', off: off as string[] };
}

const finding = (code: string, cause: string, fix: string, at: string): Finding => ({
  code,
  cause,
  fix,
  docs: ERROR_DOCS_URL,
  at,
});

/** The managed files `x kit` writes: every entry the app has not switched off. */
export const activeKit = (
  managed: readonly KitFile[],
  off: readonly string[],
): readonly KitFile[] => managed.filter((file) => !off.includes(file.name));

const same = (a: string, b: string): boolean =>
  a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

/** One finding per managed file the disk lacks or holds edited. */
async function driftFindings(disk: KitDisk, files: readonly KitFile[]): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const file of files) {
    const held = await disk.read(file.path);
    if (held !== undefined && same(held, file.contents)) continue;
    const variant =
      file.kind === 'skill'
        ? `.claude/skills/app-${file.name}/SKILL.md`
        : `.claude/agents/app-${file.name}.md`;
    found.push(
      finding(
        KIT_DRIFT,
        held === undefined
          ? `${file.path} is a managed kit file and is missing`
          : `${file.path} is a managed kit file and was edited by hand; \`x kit\` rewrites it`,
        held === undefined
          ? KIT_FIX
          : `${KIT_FIX}   # to keep your change, copy the file to ${variant} and add "${file.name}" to "off" in ${KIT_MARKER} first`,
        file.path,
      ),
    );
  }
  return found;
}

/** A `.claude/commands/<skill>.md` an ACTIVE skill of the same name silently shadows: not an "off" one. */
async function shadowFindings(disk: KitDisk, files: readonly KitFile[]): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const file of files.filter((entry) => entry.kind === 'skill')) {
    const path = `${COMMANDS_DIR}/${file.name}.md`;
    if ((await disk.read(path)) === undefined) continue;
    found.push(
      finding(
        KIT_SHADOWED,
        `${path} is shadowed by the managed skill ${file.name}: the skill runs, the command never does`,
        `git -C .claude/commands mv ${renderFixShellArg(`${file.name}.md`, '<command>.md')} ${renderFixShellArg(`app-${file.name}.md`, 'app-<command>.md')}`,
        path,
      ),
    );
  }
  return found;
}

export interface KitVerdict {
  readonly marker: KitMarker;
  readonly findings: readonly Finding[];
  /** Advice that fails nothing: the marker absent, or one the gate cannot read. */
  readonly warnings: readonly string[];
}

/**
 * The kit against the disk. A marker that reads as a list of names to leave off is honoured; one
 * that does not parse is a finding of its own, and nothing else is judged against a guess.
 */
export async function judgeKit(disk: KitDisk, managed: readonly KitFile[]): Promise<KitVerdict> {
  const marker = parseKitMarker(await disk.read(KIT_MARKER));
  if (marker.state === 'absent') {
    return {
      marker,
      findings: [],
      warnings: [`${KIT_MARKER} is absent: this app has no managed agent kit — fix: ${KIT_FIX}`],
    };
  }
  if (marker.state === 'invalid') {
    return {
      marker,
      findings: [
        finding(
          KIT_DRIFT,
          `${KIT_MARKER} is unreadable: ${marker.why}`,
          `printf '{\\n  "off": []\\n}\\n' > ${KIT_MARKER}`,
          KIT_MARKER,
        ),
      ],
      warnings: [],
    };
  }
  const files = activeKit(managed, marker.off);
  return {
    marker,
    findings: [...(await driftFindings(disk, files)), ...(await shadowFindings(disk, files))],
    warnings: [],
  };
}
