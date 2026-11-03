// Single responsibility: the instructions a pooler in the path needs, as text with no imports, so
// `errors.ts`' classifier and the factories over it can both read them without a cycle.

/**
 * `web`'s numbers, as the line an operator pastes, because the role's name is the one thing this
 * text cannot know: per-role bounds mean one database user per role. A login opened before the
 * `alter` keeps the old values, which is why reopening is part of the sentence.
 */
const ALTER_ROLE =
  "alter role <user> set statement_timeout = '10s'; " +
  "alter role <user> set idle_in_transaction_session_timeout = '30s' " +
  "(POOL_PROFILES holds every role's numbers) — " +
  "then reopen the pooler's server connections";

/** The two settings the framework itself sends as `options` when no pooler is named. */
const FRAMEWORK_OPTIONS: ReadonlySet<string> = new Set([
  'statement_timeout',
  'idle_in_transaction_session_timeout',
]);

/**
 * The fix for a refused startup parameter, decided by which one the pooler named. One of the
 * framework's own means no pooler is named yet: the switch is the answer. Any other is the
 * operator's, in `DATABASE_URL`'s `options` — with the switch set the framework sends none, so
 * naming the switch again would be a loop. A name that is not an identifier is the server's text,
 * not ours to paste, and is left out.
 */
export function poolerOptionsRefusedFix(parameter: string | undefined): string {
  if (parameter !== undefined && FRAMEWORK_OPTIONS.has(parameter)) {
    return `DATABASE_POOLER=transaction (session on a session pool), then in psql direct to the server: ${ALTER_ROLE}`;
  }
  const named = parameter !== undefined && /^[a-z_][a-z0-9_.]*$/.test(parameter);
  const option = named ? `-c ${parameter}=…` : 'the -c the cause names';
  return `remove ${option} from DATABASE_URL's options and set it with alter role <user> set … direct to the server, or add it to the pooler's ignore_startup_parameters — the pooler forwards no startup option`;
}

export const STATEMENT_BOUND_LOST_FIX = `psql direct to the server: ${ALTER_ROLE}; or set DATABASE_POOLER if a pooler sits in the path`;

export const POOLER_SESSION_REQUIRED_FIX =
  "point this role's DATABASE_URL at the server's own port, and unset DATABASE_POOLER for it";

export const IDLE_IN_TRANSACTION_FIX =
  'do slow outbound work before opening the transaction: the server closed it for sitting idle past idleInTransactionMs (POOL_PROFILES), and the await in the handler is the cause, not the connection';
