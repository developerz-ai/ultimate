// `localOnly` in `x.verify.json`: steps the gate runs on a developer's machine and leaves out of
// CI, each with a written why. For a check that costs CI minutes and answers a question the
// author's own run already did (a real-browser pass, say). A step the floor's `steps` lists stays
// floored where it runs (a laptop). `--only <step>` still runs it anywhere.

import { msg } from './messages';

/** The floor's field: step name → why CI does not run it. */
export const LOCAL_ONLY_FIELD = 'localOnly';

/** Step name → the written reason CI leaves it out. */
export type LocalOnlyReasons = Readonly<Record<string, string>>;

/** `localOnly` as `{ "<step>": "<why>" }`, or the problems; absent is none. */
export function readLocalOnly(
  payload: Record<string, unknown> | undefined,
  declared: readonly string[],
): { readonly localOnly?: LocalOnlyReasons; readonly problems: readonly string[] } {
  const raw = payload?.[LOCAL_ONLY_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { problems: [`"${LOCAL_ONLY_FIELD}" is not an object of { "<step>": "<why>" }`] };
  const problems: string[] = [];
  const reasons: Record<string, string> = {};
  for (const [step, why] of Object.entries(raw)) {
    if (!declared.includes(step))
      problems.push(
        `"${LOCAL_ONLY_FIELD}" names ${JSON.stringify(step)}, which x verify does not run`,
      );
    else if (typeof why !== 'string' || why.trim() === '')
      problems.push(`"${LOCAL_ONLY_FIELD}" gives ${JSON.stringify(step)} no written why`);
    else reasons[step] = why.trim();
  }
  return {
    ...(Object.keys(reasons).length === 0 ? {} : { localOnly: reasons }),
    problems,
  };
}

/** The steps this run leaves out, each with its why: reported, never silently gone. */
export const leftOutSteps = (
  localOnly: LocalOnlyReasons | undefined,
  steps: readonly string[],
  ci: boolean,
  only: readonly string[] | undefined,
): LocalOnlyReasons =>
  Object.fromEntries(
    steps.flatMap((step) =>
      leftOutOfCi(localOnly, step, ci, only) ? [[step, localOnly?.[step] ?? '']] : [],
    ),
  );

/** One human line per step left out, under the step table. */
export const leftOutLines = (leftOut: LocalOnlyReasons): readonly string[] =>
  Object.entries(leftOut).map(([step, reason]) =>
    msg('cli.verify.localOnly.line', { step, reason }),
  );

/** Is this step left out of this run? Only in CI, and never when `--only` names it. */
export const leftOutOfCi = (
  localOnly: LocalOnlyReasons | undefined,
  step: string,
  ci: boolean,
  only: readonly string[] | undefined,
): boolean =>
  ci && localOnly !== undefined && Object.hasOwn(localOnly, step) && !only?.includes(step);
