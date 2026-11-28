// The line every managed kit file carries under its front matter: what rewrites it, and the one
// way to own a variant. Text, not enforcement — `x verify`'s kit check is the enforcement.

import type { KitKind } from './registry';

/** The `app-<name>` path an app's own variant of a managed entry lives at. */
export const appVariantPath = (kind: KitKind, name: string): string =>
  kind === 'skill' ? `.claude/skills/app-${name}/SKILL.md` : `.claude/agents/app-${name}.md`;

/** An HTML comment: invisible to the rendered skill, read by an agent about to edit the file. */
export const managedNote = (kind: KitKind, name: string): string =>
  `<!-- Managed by Ultimate: \`bunx x kit\` rewrites this file and \`bunx x verify\` refuses an edit (X_KIT_DRIFT). To change it, copy it to \`${appVariantPath(kind, name)}\` and add "${name}" to "off" in .claude/kit.json. -->`;
