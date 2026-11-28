// `x kit` — writes the managed agent kit into the app and refreshes it after an upgrade. A file is
// rewritten only when it differs; `app-*` files, `apps/web/DESIGN.md` and any entry `.claude/kit.json`
// lists under "off" are never touched, and `.claude/kit.json` is written once, when it is absent.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { activeKit, judgeKit, parseKitMarker } from './app-kit';
import { diskAt, managedKit } from './app-kit-disk';
import { requireAppRoot } from './app-root';
import { kitSpec } from './cmd-kit-spec';
import { agentKitCodemod } from './codemods/agent-kit';
import { fsCodemodApp } from './codemods/engine-fs';
import type { CliCommand, CommandContext } from './command';
import { ScaffoldPathEscapeError } from './errors';
import { KIT_MARKER, kitMarkerFile } from './kit/registry';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';

export interface KitWrite {
  readonly path: string;
  readonly action: 'created' | 'updated';
}

/** What a refresh wrote. `findings` is what it could not decide for the author. */
export interface KitRefresh {
  readonly written: readonly KitWrite[];
  readonly unchanged: number;
  readonly off: readonly string[];
  readonly findings: readonly Finding[];
  /** Old files kept as `app-<name>.md` before the managed ones landed: the edits nothing may lose. */
  readonly renamed: readonly { readonly path: string; readonly reason: string }[];
}

/** A path the guard refused: named, with how to find the link that leaves the app. */
const escapeFinding = (path: string): Finding => ({
  code: 'X_SCAFFOLD_PATH_ESCAPE',
  cause: `${path} resolves outside the app (a symlink on the way leaves it), so x kit did not write it`,
  fix: 'find .claude -type l -ls   # each link that leaves the app: rm it, make the path a real file or directory, then: bunx x kit',
  docs: ERROR_DOCS_URL,
  at: path,
});

/** Writes every managed file that is missing or differs; the marker when absent. Never deletes. */
export async function refreshKit(root: string): Promise<KitRefresh> {
  const disk = diskAt(root);
  const managed = await managedKit(root);
  const markerText = await disk.read(KIT_MARKER);
  const marker = parseKitMarker(markerText);
  // An unreadable marker is the author's: guessing its "off" list could overwrite a file it kept.
  if (marker.state === 'invalid') {
    const verdict = await judgeKit(disk, managed);
    return { written: [], unchanged: 0, off: [], findings: verdict.findings, renamed: [] };
  }
  const off = marker.state === 'present' ? marker.off : [];
  // No marker yet: a legacy `.claude/agents/<n>.md` an author edited sits on a managed path, and the
  // write below would replace it. The codemod's own step keeps it as `app-<n>.md` first (and drops an
  // unedited released one); with a marker it does nothing, and the gate judges an edit instead.
  // Every write goes through the engine's guard (`codemods/engine-fs.ts`): a path that resolves
  // outside the app, through a symlink or not, is refused and said so, never followed.
  const app = fsCodemodApp(root);
  const refusals: Finding[] = [];
  const guarded = async <T>(path: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ScaffoldPathEscapeError)) throw error;
      refusals.push(escapeFinding(path));
      return undefined;
    }
  };
  const carried =
    marker.state === 'absent'
      ? await guarded('.claude', () => agentKitCodemod().run(app))
      : undefined;
  const renamed = (carried?.skipped ?? []).map((skip) => ({
    path: skip.path,
    reason: skip.reason,
  }));
  const written: KitWrite[] = [];
  let unchanged = 0;
  for (const file of activeKit(managed, off)) {
    const held = await guarded(file.path, () => app.read(file.path));
    if (held === undefined && refusals.some((found) => found.at === file.path)) continue;
    if (held === file.contents) {
      unchanged += 1;
      continue;
    }
    const landed = await guarded(file.path, async () => {
      await app.write(file.path, file.contents);
      return true;
    });
    if (landed === true) {
      written.push({ path: file.path, action: held === undefined ? 'created' : 'updated' });
    }
  }
  if (marker.state === 'absent') {
    const file = kitMarkerFile();
    const landed = await guarded(file.path, async () => {
      await app.write(file.path, String(file.contents));
      return true;
    });
    if (landed === true) written.push({ path: file.path, action: 'created' });
  }
  // Left for the author: a command a skill shadows is renamed with `git mv`, never by this command.
  const after = await judgeKit(disk, managed);
  return { written, unchanged, off, findings: [...refusals, ...after.findings], renamed };
}

export const kitCommand: CliCommand = {
  spec: kitSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('kit', ctx.cwd).dir;
    const done = await refreshKit(root);
    return {
      ok: done.findings.length === 0,
      command: 'kit',
      summary:
        done.written.length === 0
          ? msg('cli.kit.current', { count: done.unchanged })
          : msg('cli.kit.wrote', { count: done.written.length }),
      findings: done.findings,
      data: {
        written: done.written.map((w) => ({ ...w })),
        unchanged: done.unchanged,
        off: [...done.off],
        renamed: done.renamed.map((r) => ({ ...r })),
      },
      lines: [
        ...done.written.map((w) => `${w.action} ${w.path}`),
        ...done.renamed.map((r) => `kept ${r.path}: ${r.reason}`),
      ],
    };
  },
};
