// `reference-app-gate.ts --unpin <app>:<step>[,<step>]`, performed: the edit a stale pin's `fix:`
// names, as a command. Split from the gate because the gate JUDGES a run and this REWRITES the
// table it is judged against — two jobs, and the gate's file was at the line ceiling.

// why: the host-separator path to the pins file; Bun ships no path API.
import { join } from 'node:path';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import type { GatedApp } from './lib/gated-apps';
import { GATED_APPS, PINS_FILE } from './lib/gated-apps';
import type { ScriptResult } from './lib/log';
import { parseUnpin, pinnedSteps, removePins } from './lib/unpin';

const SCRIPT = 'reference-app-gate';

/** A refused flag, in the gate's own result shape — `--unpin`'s and `--app`'s alike. */
export const badFlag = (cause: string, fix: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary: cause,
  findings: [{ code: 'X_CLI_BAD_FLAG', cause, fix, at: PINS_FILE }],
});

/**
 * `--unpin <app>:<step>[,<step>]`, performed: the edit `X_REFERENCE_APP_PIN_STALE` names, so an
 * agent shrinks the ratchet with the line the gate printed instead of hand-editing a table.
 *
 * Fails closed at every disagreement. The steps must be pinned for that app, and the entries the
 * text parser finds must be exactly the keys the gate's own import sees — a pins file this cannot
 * read is a hand edit, never a guess at which lines to delete.
 */
export const unpin = async (
  root: string,
  token: string,
  apps: readonly GatedApp[] = GATED_APPS, // a test passes its own pinned world
): Promise<ScriptResult> => {
  const request = parseUnpin(token);
  const shape = `bun run scripts/reference-app-gate.ts --unpin ${apps[0]?.dir ?? '<app>'}:drift`;
  if (request === undefined)
    return badFlag(`--unpin "${token}" is not <app>:<step>[,<step>]`, shape);
  const app = apps.find((candidate) => candidate.dir === request.app);
  if (app === undefined) {
    return badFlag(
      `--unpin names ${request.app}, which is not a gated app`,
      `bun run scripts/reference-app-gate.ts --unpin <${apps.map((a) => a.dir).join('|')}>:<step>`,
    );
  }
  const declared = Object.keys(app.expectedRed);
  const unknown = request.steps.filter((step) => !declared.includes(step));
  if (unknown.length > 0) {
    return badFlag(
      `${unknown.join(', ')} is not pinned for ${app.dir}${declared.length === 0 ? ' — its table is already empty' : `; it pins ${declared.join(', ')}`}`,
      `bun run scripts/reference-app-gate.ts --json   # the pins each app still carries`,
    );
  }
  const path = join(root, PINS_FILE);
  const source = await Bun.file(path).text();
  const onFile = pinnedSteps(source, app.dir);
  const next = removePins(source, app.dir, request.steps);
  if (next === undefined || onFile === undefined || onFile.join() !== declared.join()) {
    const cause = `${PINS_FILE} no longer reads as the table this edit understands, so ${app.dir}'s pins were left alone`;
    return {
      ok: false,
      script: SCRIPT,
      summary: cause,
      findings: [
        {
          code: 'X_REFERENCE_APP_PIN_STALE',
          cause,
          fix: `delete the ${request.steps.join(', ')} entr${request.steps.length === 1 ? 'y' : 'ies'} from ${app.dir}'s expectedRed in ${PINS_FILE}`,
          at: PINS_FILE,
        },
      ],
    };
  }
  await Bun.write(path, next);
  const left = pinnedSteps(next, app.dir) ?? [];
  return {
    ok: true,
    script: SCRIPT,
    summary: `${app.dir}: unpinned ${request.steps.join(', ')} — ${left.length === 0 ? `no pins left, the app is asserting ${VERIFY_STEP_NAMES.length} of ${VERIFY_STEP_NAMES.length}` : `${left.join(', ')} still pinned`}`,
    lines: [`  ${PINS_FILE} rewritten`, '  now run: bun run scripts/reference-app-gate.ts'],
    data: { app: app.dir, removed: request.steps, pinned: left },
  };
};
