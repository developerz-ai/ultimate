// The managed `upgrade` skill: one major per hop, previewed, applied, its report read for what the
// codemods left, then the kit refreshed and the gate run. The procedure around `x upgrade`, which
// is the mechanism.

import type { NameSet } from '../templates/naming';
import { managedNote } from './managed';

export const upgradeSkill = (app: NameSet): string => `---
name: upgrade
description: Move ${app.kebab} to the next Ultimate major — preview with a dry run, hop, read the report (codemods that left work, guards withheld, workarounds a release superseded), refresh the agent kit, and gate. Use when asked to upgrade, bump or update the framework, or when x doctor says the app is behind.
argument-hint: [target version, optional]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

${managedNote('skill', 'upgrade')}

# upgrade

One major per hop, in lockstep: every \`@ultimat3/*\` pin moves together. A jump of three majors is
three hops, each gated.

## Target

$ARGUMENTS

Empty: the next major's newest release.

## 1. Preview

\`\`\`sh
git status                          # a clean tree, or the hop refuses
bunx x upgrade --dry-run --json     # pins, Bun floor edits, codemods, the section to read
\`\`\`

Read the section the report names in the changelog before writing anything. With a target:
\`bunx x upgrade --to <version> --dry-run --json\`.

## 2. Hop

\`\`\`sh
bunx x upgrade --json               # or: bunx x upgrade --to <version> --json
\`\`\`

It moves the pins, raises the Bun floor, installs, applies the codemods and runs the gate.

## 3. Read the report — every part of it

| Part | What it means | What you do |
|---|---|---|
| codemods: left for you | a file a codemod would not rewrite safely, with the reason | make that edit by hand, as the reason describes |
| guards: withheld | a newly shipped guard that would fail this tree today | fix what it finds, then turn it on in \`guards/shipped.json\` |
| superseded | a workaround in this app the release now does itself, with a \`fix:\` | delete the workaround; the \`verify\` skill checks the fix line first |
| gate findings | the hop's own \`bunx x verify\` run | the \`verify\` skill |

## 4. Refresh the kit

\`\`\`sh
bunx x kit --json
\`\`\`

Re-renders the managed skills and agents for the release now installed. A managed file you had
edited is reported, never silently overwritten (\`X_KIT_DRIFT\`); keep your version as an \`app-<name>\`
skill or agent and switch the managed one off in \`.claude/kit.json\`. A name of yours that collides
with a managed one is \`X_KIT_SHADOWED\` — move it to \`app-<name>\`.

## 5. Gate

\`\`\`sh
bun run verify --json
\`\`\`

Green, then commit the hop on its own: one major, one commit, before the next.

## Output

\`\`\`
Hop:       <from> → <to>
Codemods:  <applied> applied · <left> left for you — <files>
Guards:    <withheld guards, and what each found>
Kit:       <files re-rendered> · <drifted or shadowed>
Gate:      bun run verify ✓ | ✗ <failing steps>
\`\`\`
`;
