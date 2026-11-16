// The private-names secret row: whether `ULTIMATE_PRIVATE_NAMES` is set on the repository. Unset,
// the private-names guard skips the names on every pull request and reds the boundaries part of
// every push to main; this row names the secret and its command before that red does.

import { ENV_NAME } from '../private-names-match';
import { forbiddenReason, isForbidden } from './health-forbidden';
import { jsonDocument } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';

const ARGS = ['secret', 'list', '--json', 'name,updatedAt'] as const;

// Exported for the brief's test and the reader's: a re-run is the same query.
export const SECRET_COMMAND = `gh ${ARGS.join(' ')}`;
/** Prompts for the value, so the value never lands in a shell history or a log. */
export const SECRET_FIX = `gh secret set ${ENV_NAME}`;

export type SecretRead =
  | { readonly kind: 'listed'; readonly secrets: unknown }
  | { readonly kind: 'forbidden' };

export const secretReader = async (
  root: string,
  ghRunner: (args: readonly string[], cwd: string) => Promise<RunResult>,
): Promise<SecretRead> => {
  const answer = await ghRunner(ARGS, root);
  if (!answer.ok && isForbidden(answer.output)) return { kind: 'forbidden' };
  return { kind: 'listed', secrets: jsonDocument(answer.output) };
};

const names = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const read = value.flatMap((one: unknown) => {
    const name = typeof one === 'object' && one !== null ? Reflect.get(one, 'name') : undefined;
    return typeof name === 'string' && name !== '' ? [name] : [];
  });
  return read.length === value.length ? read : undefined;
};

export const judgeSecret = (read: SecretRead): RowVerdict | Finding => {
  const base = { row: 'private-names-secret' as const };
  if (read.kind === 'forbidden') {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: forbiddenReason('repository secrets'),
      fix: SECRET_COMMAND,
    };
  }
  const listed = names(read.secrets);
  if (listed === undefined) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the private-names-secret row could not be read: ${SECRET_COMMAND} — gh printed no JSON secret list`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  if (listed.includes(ENV_NAME)) {
    return { ...base, verdict: 'healthy', reason: `${ENV_NAME} is set on the repository` };
  }
  return {
    ...base,
    verdict: 'unhealthy',
    reason: `${ENV_NAME} is not set: the private-names guard skips the names, and the boundaries part of every push to main is red (X_PRIVATE_NAMES_UNSET)`,
    fix: SECRET_FIX,
  };
};
