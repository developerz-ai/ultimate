// `x kit` — writes the managed agent kit into the app and refreshes it after an upgrade. A file is
// rewritten only when it differs; `app-*` files, `apps/web/DESIGN.md` and any entry `.claude/kit.json`
// lists under "off" are never touched, and `.claude/kit.json` is written once, when it is absent.

import { join } from 'node:path';
import { activeKit, judgeKit, parseKitMarker } from './app-kit';
import { diskAt, managedKit } from './app-kit-disk';
import { requireAppRoot } from './app-root';
import { kitSpec } from './cmd-kit-spec';
import type { CliCommand, CommandContext } from './command';
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
}

/** Writes every managed file that is missing or differs; the marker when absent. Never deletes. */
export async function refreshKit(root: string): Promise<KitRefresh> {
  const disk = diskAt(root);
  const managed = await managedKit(root);
  const markerText = await disk.read(KIT_MARKER);
  const marker = parseKitMarker(markerText);
  // An unreadable marker is the author's: guessing its "off" list could overwrite a file it kept.
  if (marker.state === 'invalid') {
    const verdict = await judgeKit(disk, managed);
    return { written: [], unchanged: 0, off: [], findings: verdict.findings };
  }
  const off = marker.state === 'present' ? marker.off : [];
  const written: KitWrite[] = [];
  let unchanged = 0;
  for (const file of activeKit(managed, off)) {
    const held = await disk.read(file.path);
    if (held === file.contents) {
      unchanged += 1;
      continue;
    }
    await Bun.write(join(root, file.path), file.contents);
    written.push({ path: file.path, action: held === undefined ? 'created' : 'updated' });
  }
  if (marker.state === 'absent') {
    const file = kitMarkerFile();
    await Bun.write(join(root, file.path), file.contents);
    written.push({ path: file.path, action: 'created' });
  }
  // Left for the author: a command a skill shadows is renamed with `git mv`, never by this command.
  const after = await judgeKit(disk, managed);
  return { written, unchanged, off, findings: after.findings };
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
      },
      lines: done.written.map((w) => `${w.action} ${w.path}`),
    };
  },
};
