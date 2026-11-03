// Single responsibility: the instructions a pooler in the path needs, as text with no imports, so
// `errors.ts`' classifier and the factories over it can both read them without a cycle.

/**
 * `web`'s numbers, as a command an operator pastes: `<user>` is the one thing this text cannot
 * know, because per-role bounds mean one database user per role. Through the pooler or direct,
 * `alter role` is an ordinary statement. A login opened before the `alter` keeps the old values,
 * which is why reopening is in the comment after `#`, where prose belongs.
 */
/**
 * `DATABASE_URL` with its `options` query parameter cut out, as shell: the pooler refused the
 * connection for an option in there, so a `psql` that sent it again would fail before `alter role`
 * ran. Every other parameter (`sslmode`, `application_name`) stays, and only the query is
 * searched: a password may read `&options=`, the query starts at the first `?`.
 */
const PSQL_WITHOUT_OPTIONS = `psql "$(printf '%s' "$DATABASE_URL" | sed -E 's/^([^?]*\\?([^&]*&)*)options=[^&]*(&|$)/\\1/; s/[?&]$//')"`;

const ALTER_ROLE =
  `${PSQL_WITHOUT_OPTIONS} -c "alter role <user> set statement_timeout = '10s'" ` +
  `-c "alter role <user> set idle_in_transaction_session_timeout = '30s'"`;

const ALTER_ROLE_NOTE =
  "<user> is this role's database user, POOL_PROFILES holds every role's numbers; then reopen the pooler's server connections (RECONNECT on its admin console), a role setting applies at login";

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
    return `export DATABASE_POOLER=transaction && ${ALTER_ROLE}   # session on a session pool; ${ALTER_ROLE_NOTE}`;
  }
  const named = parameter !== undefined && /^[a-z_][a-z0-9_.]*$/.test(parameter);
  const setting = named ? parameter : '<setting>';
  return `${PSQL_WITHOUT_OPTIONS} -c "alter role <user> set ${setting} = '<value>'"   # then remove -c ${setting}=… from the options of DATABASE_URL, or add it to ignore_startup_parameters of the pooler: a pooler forwards no startup option`;
}

export const STATEMENT_BOUND_LOST_FIX = `${ALTER_ROLE}   # ${ALTER_ROLE_NOTE}; and export DATABASE_POOLER=transaction (or session) if a pooler sits in the path`;

export const POOLER_SESSION_REQUIRED_FIX =
  'unset DATABASE_POOLER   # for this role only, and point its DATABASE_URL at the server port rather than the pooler';

export const IDLE_IN_TRANSACTION_FIX =
  'do slow outbound work before opening the transaction: the server closed it for sitting idle past idleInTransactionMs (POOL_PROFILES), and the await in the handler is the cause, not the connection';
