// `--write-pin <name>[,<name>]` for every ratchet that hands its spec here: the raise each named
// `over` row's finding prints (`pin-edit.ts`), drafted into the pins file with the `// why:`
// placeholder a person then rewrites. Anything else is `ratchetMain`, untouched — one wrapper, so no
// ratchet grows its own copy of the flag.

import { renderFixShellArg } from '../../packages/core/src/error-render';
import { flagList, parseScriptArgs } from './args';
import { report } from './log';
import type { PinRaise, PinTarget } from './pin-edit';
import { applyPinRaise, PIN_WHY_PLACEHOLDER, pinRaiseOf } from './pin-edit';
import type { RatchetSpec } from './ratchet';
import { ratchetGaps, ratchetMain } from './ratchet';
import { repoRoot } from './run';
import { ScriptError } from './script-error';

export interface PinEditSpec<S extends { readonly path: string }> extends RatchetSpec<S> {
  readonly target: PinTarget;
}

/** A row answers a name when the name is its key, or — a per-site table — the file it opens with. */
const answers = (key: string, name: string): boolean => key === name || key.startsWith(`${name}: `);

/**
 * Draft each named row's raise into the pins file and return what was written. Only rows over
 * their pin: a name the tree does not take over its pin drafts nothing, because there is no count
 * to raise it to.
 */
export async function writePins<S extends { readonly path: string }>(
  root: string,
  spec: PinEditSpec<S>,
  names: readonly string[],
): Promise<readonly PinRaise[]> {
  const sites = await spec.sites(root);
  const raises = ratchetGaps(sites, spec.pins, true, spec.groupOf)
    .filter((gap) => gap.kind === 'over' && names.some((name) => answers(gap.pkg, name)))
    .map((gap) => pinRaiseOf(spec.target, gap));
  if (raises.length === 0) return [];
  const path = `${root}/${spec.target.file}`;
  let text = await Bun.file(path).text();
  for (const raise of raises) text = applyPinRaise(text, raise);
  await Bun.write(path, text);
  return raises;
}

/** A ratchet's command: `--write-pin` drafts, everything else is `ratchetMain`. */
export async function ratchetPinMain<S extends { readonly path: string }>(
  spec: PinEditSpec<S>,
): Promise<never> {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const names = flagList(args, 'write-pin');
  if (!args.flags.has('write-pin')) return ratchetMain(spec);
  let raises: readonly PinRaise[];
  try {
    if (names.length === 0) {
      throw new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: '--write-pin names no row, and a draft for every row would raise pins nobody chose',
        fix: `bun run ${renderFixShellArg(spec.target.script, '<the ratchet script>')} --json   # then pass --write-pin a row key one of its over findings names`,
      });
    }
    raises = await writePins(repoRoot(), spec, names);
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    return report(
      {
        ok: false,
        script: spec.script,
        summary: 'nothing was written',
        findings: [error.toFinding()],
      },
      args.json,
    );
  }
  const drafted = raises.map(
    (raise) => `${raise.key} ${String(raise.from)} -> ${String(raise.to)}`,
  );
  return report(
    {
      ok: true,
      script: spec.script,
      summary:
        raises.length === 0
          ? `nothing to raise — no named row is over its pin in ${spec.target.file}`
          : `drafted ${String(raises.length)} raise(s) in ${spec.target.file}: ${drafted.join(', ')} — rewrite each "${PIN_WHY_PLACEHOLDER}" as the reason; pin-raises and the pin-edit test refuse it as written`,
      findings: [],
      data: { file: spec.target.file, raises },
    },
    args.json,
  );
}
