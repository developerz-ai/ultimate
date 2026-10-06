// The `AppConfig` declaration, parsed: which files declare it, and every leaf key it has, derived
// from the declaration's own text. `scripts/config-readers.ts` holds each leaf to a reader;
// `scripts/doc-config-keys.ts` holds the docs to the same set.

/**
 * The declaration, and the interface the walk starts from.
 *
 * A LIST, not one file, `As of 2026-08-27`. It was one path, and `config.ts` then reached its
 * 500-line ceiling and the `pwa` block moved to `config-pwa.ts` — at which point the walk stopped
 * finding `PwaConfig`, the derived leaf set silently LOST five keys, and this rule reported green
 * over every one of them. That is the rule's own defect class, wearing the shape of a file split:
 * a derivation whose source is a single hardcoded path is a hand list with extra steps. Text is
 * concatenated before the walk, so a section declared anywhere in the list resolves.
 *
 * The FIRST entry is what a finding cites — the file that declares `AppConfig` itself, and the one
 * an author edits to delete a section.
 */
export const CONFIG_FILES = [
  'packages/core/src/config.ts',
  'packages/core/src/config-pwa.ts',
  'packages/core/src/config-site.ts',
  'packages/core/src/config-health.ts',
  'packages/core/src/config-navigation.ts',
  'packages/core/src/config-islands.ts',
  'packages/core/src/config-ai.ts',
  'packages/core/src/config-mail.ts',
] as const;
export const CONFIG_FILE = CONFIG_FILES[0];
export const ROOT_INTERFACE = 'AppConfig';

/** Every declaring file's text, joined — what `configLeaves` walks. */
export const configDeclaration = async (root: string): Promise<string> =>
  (await Promise.all(CONFIG_FILES.map((path) => Bun.file(`${root}/${path}`).text()))).join('\n');

/**
 * A section's DECLARATION, in both spellings TypeScript offers: `export interface X { … }` and
 * `export type X = { … };`. The alias form was unread until 2026-09-06, so a section written that
 * way contributed zero leaves and every key under it read as alive — this rule's own defect class
 * one level up, and the same shape as `PwaConfig` losing five keys to a file split.
 */
const INTERFACE = /export (?:interface (\w+)\s*|type (\w+)\s*=\s*)\{([\s\S]*?)\n\}/g;

/**
 * A member: `readonly queues: readonly string[];`, at ANY indent and with `readonly` OPTIONAL.
 *
 * It demanded exactly two spaces AND the modifier, which is a rule about this repo's current
 * formatting wearing a rule about a declaration — a section nested one level deeper, or one member
 * written without `readonly`, dropped out of the derived set in silence. A guard a reformat evades
 * is not a guard.
 */
const MEMBER = /^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/gm;
/** A member whose type is a single named interface — the one shape the walk descends into. */
const NAMED_TYPE = /^([A-Z]\w*)(?:\s*\|\s*undefined)?$/;

/**
 * Every leaf key of `AppConfig`, dotted. Derived from the declaration's own text rather than typed
 * out here: a hand list is the defect this check exists to catch, one level up.
 */
export function configLeaves(source: string, root = ROOT_INTERFACE): readonly string[] {
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(INTERFACE))
    bodies.set((match[1] ?? match[2]) as string, match[3] as string);
  const leaves: string[] = [];
  const walk = (name: string, prefix: string, seen: readonly string[]): void => {
    const body = bodies.get(name);
    // A cycle would recurse forever, and a self-referential config is not a thing this repo has —
    // but a check that hangs is worse than one that reports nothing, so the guard is cheap.
    if (body === undefined || seen.includes(name)) return;
    for (const member of body.matchAll(MEMBER)) {
      const key = member[1] as string;
      const type = (member[2] as string).trim();
      const target = NAMED_TYPE.exec(type)?.[1];
      if (target !== undefined && bodies.has(target))
        walk(target, `${prefix}${key}.`, [...seen, name]);
      else leaves.push(`${prefix}${key}`);
    }
  };
  walk(root, '', []);
  return leaves;
}
