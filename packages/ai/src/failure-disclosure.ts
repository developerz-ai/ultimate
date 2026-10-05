// The one rule for what of a thrown value a remote reader may see: an LLM tool result and a hive
// member's reason both reach someone outside this process, so both ask this file — and the half
// it withholds goes to the log, which is what makes "the details are in the server logs" true.

import type { Logger } from '@ultimat3/core';
import { hasPublicCause, isUltimateError, renderThrowable, stringField } from '@ultimat3/core';
import { statusFor } from '@ultimat3/http';

/**
 * What may be shown. `code` is absent for an uncoded throw — a foreign `.message` is the server's
 * (a pg `Key (email)=(…)`), so nothing of it is carried. `cause` is absent when it is withheld:
 * the caller substitutes its own fixed sentence, because who is reading decides the wording.
 */
export interface DisclosedFailure {
  readonly code: string | undefined;
  readonly cause: string | undefined;
  readonly fix: string | undefined;
}

/**
 * Read STRUCTURALLY and totally — `stringField`, never `typeof e.code` or `.message`: the value is
 * whatever an app's handler, its driver or its SDK threw, so each read is a getter call or a
 * `Proxy` trap, and this runs inside a catch block with nothing left to answer if a probe raises.
 *
 * A 5xx code's cause is shown only when core's `hasPublicCause` allows it — the rule a production
 * problem document follows (`@ultimat3/http`'s `toProblem`). Hidden, the developer's `fix` goes
 * with it (a driver writes it from the statement it failed on); a `callerFix` an `UltimateError`
 * built in this process is authored for a remote reader and stays.
 */
export function discloseFailure(
  error: unknown,
  logger: Logger | undefined,
  where: string,
): DisclosedFailure {
  const code = stringField(error, 'code');
  if (code === undefined) return withheld(error, logger, where, undefined, undefined);
  if (statusFor(code) >= 500 && !hasPublicCause(code)) {
    const callerFix = isUltimateError(error) ? stringField(error, 'callerFix') : undefined;
    return withheld(error, logger, where, code, callerFix);
  }
  const fix = stringField(error, 'fix');
  return {
    code,
    cause: stringField(error, 'cause') ?? 'unknown',
    fix: fix === undefined || fix === '' ? undefined : fix,
  };
}

/** The withheld half, logged whole — `renderThrowable` is total over a hostile value too. */
function withheld(
  error: unknown,
  logger: Logger | undefined,
  where: string,
  code: string | undefined,
  fix: string | undefined,
): DisclosedFailure {
  logger?.error('ai.failure.withheld', {
    where,
    code: code ?? 'uncoded',
    error: renderThrowable(error),
    cause: stringField(error, 'cause') ?? null,
  });
  return { code, cause: undefined, fix };
}
