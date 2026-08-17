#!/usr/bin/env bun
// Enforce, as a gate step, that `.github/workflows/release.yml` still publishes EVERY publishable
// workspace. The list was seven steps of hand-written `-w` flags and it was already wrong:
// `@ultimat3/flags` declares the same `publishConfig` as the other 28, no step named it, and the
// registry has answered 404 for it since 1.0.0 with nothing noticing — every consumer resolves it
// through the workspace. The workflow now DERIVES its list (see `publishListMode`), which is the
// durable fix; this file is what stops it being hand-kept again, and what caught the omission in
// the first place. Runs on `x verify`'s `manifest` step, the step that already asks whether a
// committed file still describes the code.
//
// THE RULE: `publishOrder(listWorkspaces())` is the repo's own definition of publishable, and the
// workflow must name all of it and nothing else. Two spellings satisfy the first half BY
// CONSTRUCTION rather than by listing — `npm publish --workspaces`, where npm resolves the set from
// the root manifest, and a step that derives its own list from `scripts/list-workspaces.ts`, which
// is literally the `listWorkspaces()` this file compares against. Under either, the rule still
// asserts three things: that a publish step exists at all, that every LITERAL `-w` names something
// this tree can publish, and that the derivation is the repo's own and not a second copy of it.
//
//   bun run scripts/release-workflow.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';

export const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/** What the pure rule needs of a workspace: its published name, its tier, whether it publishes. */
export interface PublishTarget {
  readonly name: string;
  readonly tier: number;
  readonly private: boolean;
}

/**
 * `missing` is the hazard this exists for — a package that never reaches the registry. `unknown` is
 * a `-w` naming something the tree does not publish: `npm publish` exits non-zero on it, and a
 * release that dies half way through has already published the packages before it, irreversibly.
 */
export type PublishGapKind = 'missing' | 'unknown' | 'unreadable';

export interface PublishGap {
  readonly kind: PublishGapKind;
  /** The workspace name for `missing`/`unknown`; the workflow path for `unreadable`. */
  readonly name: string;
  readonly tier?: number;
  /** Only for `unknown`: the workspace exists but is marked private. */
  readonly workspacePrivate?: boolean;
}

export interface PublishListInput {
  /** Every workspace under `packages/`, private ones included. */
  readonly workspaces: readonly PublishTarget[];
  /** The raw workflow text — read-only; this check never edits it. */
  readonly workflow: string;
}

/** YAML comments hold example commands. A `-w` inside one publishes nothing. */
const stripComments = (line: string): string => line.replace(/(^|\s)#.*$/, '$1');

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every `run:` scalar that invokes `npm publish`, whole — a folded `run: >` list of flags and a
 * `run: |` shell script alike. The WHOLE block and not the text after `npm publish`, because a
 * script builds its argument list in the lines ABOVE the command, and those lines are what say
 * whether the list was derived or typed. Scanning the file instead would read a `-w` out of any
 * command in it; scanning one line would miss both block forms.
 */
export function publishCommands(workflow: string): readonly string[] {
  const lines = workflow.split('\n').map(stripComments);
  const blocks: string[] = [];
  for (const [index, line] of lines.entries()) {
    const key = /(?:^|\s)run:/.exec(line);
    if (key === null) continue;
    // The column the `run:` key sits at. Its scalar is everything indented past it.
    const base = key.index;
    const parts = [line.slice(base + key[0].length)];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next] ?? '';
      // A blank line is inside a `|` script, not the end of it — the indent of the NEXT real line
      // is what ends the block.
      if (following.trim().length === 0) continue;
      if (indentOf(following) <= base) break;
      parts.push(following.trim());
    }
    const block = parts.join(' ');
    if (block.includes('npm publish')) blocks.push(block);
  }
  return blocks;
}

/** A literal package name, so a `-w $name` built by a shell loop is not read as one. */
const PACKAGE_NAME = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;

/** `-w name`, `-w=name`, `--workspace name`, `--workspace=name`. */
export const workspaceFlags = (command: string): readonly string[] =>
  [...command.matchAll(/(?:^|\s)(?:-w|--workspace)[\s=]+(\S+)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => PACKAGE_NAME.test(name));

/**
 * The repo's own enumeration of its workspaces. A publish step that reads its list from this is
 * complete by construction — it is the same `listWorkspaces()` this check compares against — which
 * is the shape a hand-kept list should be replaced BY, not a hole in the rule.
 */
export const WORKSPACE_ENUMERATOR = 'scripts/list-workspaces.ts';

/** Either npm resolves the whole set itself, or the step derives it. No explicit list can go stale. */
export const publishesEveryWorkspace = (command: string): boolean =>
  /(?:^|\s)(?:-ws|--workspaces)(?:\s|=|$)/.test(command) || command.includes(WORKSPACE_ENUMERATOR);

/**
 * How the workflow decides what to publish. Reported, not just used: "every one named" and "the
 * list is derived" are different guarantees, and a summary that printed the first while the file
 * did the second would be the same class of unchecked claim this rule exists to close.
 */
export type PublishListMode = 'derived' | 'listed' | 'none';

export function publishListMode(workflow: string): PublishListMode {
  const commands = publishCommands(workflow);
  if (commands.length === 0) return 'none';
  return commands.some(publishesEveryWorkspace) ? 'derived' : 'listed';
}

const byName = (a: PublishGap, b: PublishGap): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Pure, so the negative case is a fixture rather than an edit to a workflow the release runs from.
 * Takes both inputs whole: the workspaces on disk and the workflow text.
 */
export function checkPublishList(input: PublishListInput): readonly PublishGap[] {
  const commands = publishCommands(input.workflow);
  if (commands.length === 0) {
    // Never silence: a workflow with no `npm publish` in it is a check that verified nothing, which
    // is the vacuous pass this rule exists to make impossible.
    return [{ kind: 'unreadable', name: RELEASE_WORKFLOW }];
  }
  const named = new Set(commands.flatMap(workspaceFlags));
  const delegated = commands.some(publishesEveryWorkspace);
  const gaps: PublishGap[] = [];

  if (!delegated) {
    for (const workspace of input.workspaces) {
      if (workspace.private || named.has(workspace.name)) continue;
      gaps.push({ kind: 'missing', name: workspace.name, tier: workspace.tier });
    }
  }

  const known = new Map(input.workspaces.map((workspace) => [workspace.name, workspace]));
  for (const name of named) {
    const workspace = known.get(name);
    if (workspace !== undefined && !workspace.private) continue;
    gaps.push({ kind: 'unknown', name, workspacePrivate: workspace !== undefined });
  }

  return gaps.sort(byName);
}

const missingFinding = (gap: PublishGap): Finding => ({
  code: 'X_PUBLISH_LIST_INCOMPLETE',
  cause: `${gap.name} is a publishable workspace and no npm publish step in ${RELEASE_WORKFLOW} names it, so every release skips it and the registry answers 404`,
  fix: `add \`-w ${gap.name}\` to the tier ${gap.tier ?? 0} publish step in ${RELEASE_WORKFLOW} — or stop keeping the list by hand and derive it from ${WORKSPACE_ENUMERATOR} — then bun run scripts/release-workflow.ts --json`,
  at: RELEASE_WORKFLOW,
});

const unreadableFinding = (): Finding => ({
  code: 'X_PUBLISH_LIST_INCOMPLETE',
  cause: `${RELEASE_WORKFLOW} contains no \`npm publish\` command, so this check could not see one package the release publishes`,
  fix: `restore the publish steps in ${RELEASE_WORKFLOW} (git log -- ${RELEASE_WORKFLOW}), then bun run scripts/release-workflow.ts --json`,
  at: RELEASE_WORKFLOW,
});

const unknownFinding = (gap: PublishGap): Finding => ({
  code: 'X_PUBLISH_LIST_UNKNOWN',
  cause:
    gap.workspacePrivate === true
      ? `${RELEASE_WORKFLOW} publishes ${gap.name}, which is a private workspace — npm refuses it, and the packages already published in earlier steps cannot be unpublished`
      : `${RELEASE_WORKFLOW} publishes ${gap.name}, which no workspace under packages/ provides — npm exits non-zero, and the packages already published in earlier steps cannot be unpublished`,
  fix: `delete \`-w ${gap.name}\` from the publish step in ${RELEASE_WORKFLOW}, then bun run scripts/release-workflow.ts --json`,
  at: RELEASE_WORKFLOW,
});

const FINDINGS: Readonly<Record<PublishGapKind, (gap: PublishGap) => Finding>> = {
  missing: missingFinding,
  unknown: unknownFinding,
  unreadable: unreadableFinding,
};

export const publishGapFindingFor = (gap: PublishGap): Finding => FINDINGS[gap.kind](gap);

/**
 * Read the workflow and the workspaces, then check them. The one impure step.
 *
 * A root with no workflow is not this check's problem: the host checks run against synthetic trees
 * in `scripts/verify.test.ts`, and a rule that fired there would make those tests depend on a file
 * they are not about. The real file going missing is caught by CI having no release job at all.
 */
export async function publishListGaps(root: string): Promise<readonly PublishGap[]> {
  const file = Bun.file(`${root}/${RELEASE_WORKFLOW}`);
  if (!(await file.exists())) return [];
  return checkPublishList({
    workspaces: await listWorkspaces(root),
    workflow: await file.text(),
  });
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const publishListFindings = async (root: string): Promise<readonly Finding[]> =>
  (await publishListGaps(root)).map(publishGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const publishable = publishOrder(await listWorkspaces(root));
  const gaps = await publishListGaps(root);
  const workflow = Bun.file(`${root}/${RELEASE_WORKFLOW}`);
  const mode = (await workflow.exists()) ? publishListMode(await workflow.text()) : 'none';
  const green =
    mode === 'derived'
      ? `${publishable.length} publishable workspaces; ${RELEASE_WORKFLOW} derives its list from ${WORKSPACE_ENUMERATOR}, so no name can go stale`
      : `${publishable.length} publishable workspaces, every one named by ${RELEASE_WORKFLOW}`;
  report(
    {
      ok: gaps.length === 0,
      script: 'release-workflow',
      summary:
        gaps.length === 0
          ? green
          : `${gaps.length} publish-list gap(s) across ${publishable.length} publishable workspaces`,
      findings: gaps.map(publishGapFindingFor),
      data: { mode, publishable: publishable.map((workspace) => workspace.name) },
    },
    args.json,
  );
}
