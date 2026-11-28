// `apps/web/DESIGN.md`, the app's own design brief: tokens as front matter, then type, space,
// shape, motion and the sources each was measured from. Written once by `x new` and never managed —
// the `design-research` skill fills it, the `web` agent reads it first.

import type { GeneratedFile, NameSet } from './naming';

export const DESIGN_PATH = 'apps/web/DESIGN.md';

const design = (app: NameSet): string => `---
# The theme this design asks for: the argument apps/web/shared/theme.ts passes to defineTheme().
# Empty until the design-research skill (or you) fills it; defineTheme's contrast checks are the floor.
tokens: {}
---

# ${app.pascal} — design

Owned by this app. No command rewrites it. The \`web\` agent reads it before it renders anything.

## Type

Families, the scale in use, and where each size appears.

## Space and shape

The spacing rungs and radii this app leans on.

## Motion

Which \`@ultimat3/ui/motion\` call or \`@ultimat3/effects\` entry each moving thing uses, and why it
moves at all.

## Sources

| URL | Licence posture | Taken (numbers only) |
|---|---|---|
`;

/** The stub: the app's file from the moment it lands. */
export function designFiles(app: NameSet): readonly GeneratedFile[] {
  return [{ path: DESIGN_PATH, contents: design(app) }];
}
