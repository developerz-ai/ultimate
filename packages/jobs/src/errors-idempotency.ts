// `X_IDEMPOTENCY_REQUIRED`: a job declared with no `idempotencyKey`, named by the file and line that
// called `job()` — the refusal fires at declaration, before `defineApi` stamps the export name, so
// the file is the one name an unnamed job has yet.
import { renderCauseValue, UltimateError } from '@ultimat3/core';

/** This package's root (`src/`'s or `dist/`'s parent): its own frames are `job()`, never the caller. */
const PACKAGE_ROOT = import.meta.dir.replace(/[\\/](?:src|dist)$/, '');

const FRAME = /(?:\(|at\s+)(?:file:\/\/)?([^()\s][^()]*?):(\d+):\d+\)?\s*$/;

const slashed = (path: string): string => path.replaceAll('\\', '/');

/**
 * The first frame outside this package and `node_modules` — the declaring module — relative to
 * `cwd` when under it. A test file in this package is a caller, not a library frame.
 */
export function declarationSite(
  stack: string,
  cwd: string,
  ownRoot: string = PACKAGE_ROOT,
): { readonly file: string; readonly line: number } | undefined {
  const own = `${slashed(ownRoot)}/`;
  const root = `${slashed(cwd)}/`;
  for (const frame of stack.split('\n').slice(1)) {
    const match = FRAME.exec(frame.trim());
    if (match === null) continue;
    const file = slashed(match[1] as string);
    if (file.includes('/node_modules/')) continue;
    if (file.startsWith(own) && !/\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    return { file: file.startsWith(root) ? file.slice(root.length) : file, line: Number(match[2]) };
  }
  return undefined;
}

/** `send-reminder.ts` → `sendReminder`: `x g`'s file per primitive, its export the camel case. */
const nameFromFile = (file: string): string | undefined => {
  const stem = /([^/]+?)(?:\.[cm]?[jt]sx?)?$/.exec(file)?.[1] ?? '';
  const camel = stem.replace(/[-_.]+([a-zA-Z0-9])/g, (_, next: string) => next.toUpperCase());
  return /^[A-Za-z_$][\w$]*$/.test(camel) ? camel : undefined;
};

/**
 * The type signature already requires `idempotencyKey`; this is the runtime backstop for
 * generated code and JS callers, so the guarantee holds at both ends.
 *
 * `positional` is a name `job()` minted from a counter (`anonymous-job-3`): it MOVES when an import
 * is added above the declaration, so it is never spliced into a key template — persisted keys would
 * stop matching. The key's prefix is read off the declaring file instead, a literal that holds.
 */
export class IdempotencyRequiredError extends UltimateError {
  constructor(input: { job: string; positional?: boolean }) {
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, IdempotencyRequiredError);
    const site = declarationSite(holder.stack ?? '', process.cwd());
    const at = site === undefined ? '' : `${site.file}:${site.line}`;
    const positional = input.positional === true;
    const prefix = positional
      ? site === undefined
        ? undefined
        : nameFromFile(site.file)
      : input.job;
    const who = positional
      ? `the unnamed job${at === '' ? '' : ` declared at ${at}`} (positional name ${renderCauseValue(input.job)})`
      : `job ${renderCauseValue(input.job)}${at === '' ? '' : ` (declared at ${at})`}`;
    const where = at === '' ? 'the job({ … }) declaration' : `the job({ … }) at ${at}`;
    super({
      code: 'X_IDEMPOTENCY_REQUIRED',
      cause: `${who} has no idempotencyKey — at-least-once delivery would run it twice`,
      fix: `idempotencyKey: (input) => \`${prefix ?? '<job>'}:\${input.id}\`   // add to ${where}; the key prefix is a stable literal — an unnamed job's name is its export name, stamped when apps/web/api/index.ts's defineApi registers it`,
    });
  }
}
