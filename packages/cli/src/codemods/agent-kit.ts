// The agent kit replaces what `x new` once wrote as `.claude/commands/{feature,planx,verify}.md` and
// `.claude/agents/{shape,data,server,web}.md`: an unedited copy — any text a release shipped — is
// deleted, because `x kit` writes the managed skill or agent in its place; an edited one is kept as
// the app's own `app-<name>.md`, with the diff to the managed file, so no edit is ever lost.

import { isReleasedKitForm } from '../app-kit-forms';
import { KIT_MARKER, kitFiles } from '../kit/registry';
import { RELEASED_KIT_FORMS } from '../templates/kit-released-forms';
import { names } from '../templates/naming';
import { claudeFiles } from '../templates/scaffold-claude';
import { appName } from './agents-dev-mcp';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';

/** Each old file, and the managed file that now answers the same question. */
const sameText = (a: string, b: string): boolean =>
  a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

const OLD_FILES: readonly { readonly path: string; readonly now: string }[] = [
  { path: '.claude/commands/feature.md', now: '.claude/skills/feature/SKILL.md' },
  { path: '.claude/commands/planx.md', now: '.claude/skills/planx/SKILL.md' },
  { path: '.claude/commands/verify.md', now: '.claude/skills/verify/SKILL.md' },
  { path: '.claude/agents/shape.md', now: '.claude/agents/shape.md' },
  { path: '.claude/agents/data.md', now: '.claude/agents/data.md' },
  { path: '.claude/agents/server.md', now: '.claude/agents/server.md' },
  { path: '.claude/agents/web.md', now: '.claude/agents/web.md' },
];

/** `<dir>/app-<name>.md`, or the first `app-<name>-<n>` the app does not already hold. */
const freePath = async (app: CodemodApp, path: string): Promise<string> => {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1, -'.md'.length);
  for (let n = 1; ; n += 1) {
    const candidate = `${dir}/app-${name}${n === 1 ? '' : `-${String(n)}`}.md`;
    if (!(await app.exists(candidate))) return candidate;
  }
};

/** An agent's `name:` is its identity: the copy renamed to `app-<n>` must not still claim `<n>`. */
const renamedAgent = (text: string, name: string): string =>
  text.replace(
    new RegExp(`^(---\\r?\\n(?:[^\\n]*\\n)*?name:[ \\t]*)${name}([ \\t]*\\r?$)`, 'm'),
    `$1app-${name}$2`,
  );

async function run(
  app: CodemodApp,
  forms: Readonly<Record<string, readonly string[]>>,
): Promise<CodemodResult> {
  const changed: string[] = [];
  const skipped: CodemodResult['skipped'] = [];
  // Opted in already: the files at these paths are the kit's own, and `x verify` judges them.
  if (await app.exists(KIT_MARKER)) return { changed, skipped };
  const name = appName((await app.read('package.json')) ?? '') ?? '';
  const managed = new Map(
    kitFiles(names(name === '' ? 'app' : name)).map((f) => [f.path, f.contents]),
  );
  for (const { path, now } of OLD_FILES) {
    const held = await app.read(path);
    if (held === undefined) continue;
    // What `x kit` writes today is no old file: an agent already as rendered stays.
    if (managed.get(path)?.replaceAll('\r\n', '\n') === held.replaceAll('\r\n', '\n')) continue;
    const known = Object.hasOwn(forms, path) ? forms[path] : undefined;
    if (isReleasedKitForm(held, [name], known)) {
      await app.remove(path);
      changed.push(path);
      continue;
    }
    const target = await freePath(app, path);
    const stem = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
    await app.write(target, path.startsWith('.claude/agents/') ? renamedAgent(held, stem) : held);
    await app.remove(path);
    changed.push(path, target);
    skipped.push({
      path: target,
      reason: `${path} was edited, so it is kept as your own ${target}; the managed ${now} (written by x kit) replaces it — carry what you changed into ${target} or drop it`,
      diff: unifiedDiff(target, held, managed.get(now) ?? ''),
    });
  }
  await carryReadme(app, { name, forms, changed, skipped });
  return { changed, skipped };
}

const README = '.claude/README.md';

/**
 * `.claude/README.md` said "nothing here is enforced" until the kit made the managed files so. An
 * unedited released copy is replaced by the new one; an edited one is kept and reported with the
 * diff to the new text, because its prose is the author's.
 */
async function carryReadme(
  app: CodemodApp,
  input: {
    readonly name: string;
    readonly forms: Readonly<Record<string, readonly string[]>>;
    readonly changed: string[];
    readonly skipped: CodemodResult['skipped'];
  },
): Promise<void> {
  const held = await app.read(README);
  const next = claudeFiles(names(input.name === '' ? 'app' : input.name)).find(
    (file) => file.path === README,
  )?.contents;
  if (held === undefined || typeof next !== 'string' || sameText(held, next)) return;
  const known = Object.hasOwn(input.forms, README) ? input.forms[README] : undefined;
  if (isReleasedKitForm(held, [input.name], known)) {
    await app.write(README, next);
    input.changed.push(README);
    return;
  }
  input.skipped.push({
    path: README,
    reason: `${README} was edited, so it is kept; it still says nothing here is enforced, which is no longer true of the managed kit — merge what the new one says (the diff) into it`,
    diff: unifiedDiff(README, held, next),
  });
}

/** The migration over a released-forms table: the committed one, or a test's own. */
export const agentKitCodemod = (
  forms: Readonly<Record<string, readonly string[]>> = RELEASED_KIT_FORMS,
): Codemod => ({
  id: 'agent-kit',
  since: '31.53.0',
  summary:
    'the agent kit is managed (x kit): unedited .claude/commands and .claude/agents deleted, an edited one kept as app-<name>.md',
  run: (app) => run(app, forms),
});

export const codemod: Codemod = agentKitCodemod();
