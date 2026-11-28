// The agent kit a hop refreshes, after the codemods and before the manifest and the doctor: the
// INSTALLED CLI's `x kit --json` writes the release it just installed — never this process's, which
// may be majors older. No `kit` command answers no `data.written`: `reported: false`, unknown.

import { t } from '@ultimat3/schema';
import type { ExecResult } from './exec';
import { documentIn } from './upgrade-document';

const FINDING = t.object({
  code: t.string,
  cause: t.string,
  fix: t.string,
  at: t.optional(t.string),
});
const KIT = t.object({
  findings: t.optional(t.array(FINDING)),
  data: t.optional(
    t.object({
      written: t.optional(t.array(t.object({ path: t.string, action: t.string }))),
      unchanged: t.optional(t.number),
      off: t.optional(t.array(t.string)),
    }),
  ),
});

export interface HopKit {
  /** False when the installed CLI answered no kit document: it predates `x kit`. */
  readonly reported: boolean;
  /** Files the installed CLI wrote: `created` or `updated`, app-root relative. */
  readonly written: readonly { readonly path: string; readonly action: string }[];
  readonly unchanged: number;
  /** The entries `.claude/kit.json` leaves alone. */
  readonly off: readonly string[];
  /** What `x kit` could not decide for the author (a shadowed command), with the fix. */
  readonly findings: readonly {
    readonly code: string;
    readonly cause: string;
    readonly fix: string;
    readonly at?: string;
  }[];
}

export const NO_KIT: HopKit = { reported: false, written: [], unchanged: 0, off: [], findings: [] };

/** The installed `x kit --json`, read as the foreign document it is. */
export function readKit(result: ExecResult): HopKit {
  const parsed = KIT.safeParse(documentIn(result.stdout));
  if (parsed.issues !== undefined) return NO_KIT;
  const document = parsed.value as {
    readonly findings?: HopKit['findings'];
    readonly data?: {
      readonly written?: HopKit['written'];
      readonly unchanged?: number;
      readonly off?: readonly string[];
    };
  };
  if (document.data?.written === undefined) return NO_KIT;
  return {
    reported: true,
    written: document.data.written,
    unchanged: document.data.unchanged ?? 0,
    off: document.data.off ?? [],
    findings: document.findings ?? [],
  };
}
