// The one rule for what of a thrown value a remote reader may see: an LLM tool result and a hive
// member's reason both reach someone outside this process, so both ask this file — and the half
// it withholds goes to the log as content-free facts (code, name, frames) — never its text.

import type { Logger } from '@ultimat3/core';
import { hasPublicCause, isUltimateError, stringField } from '@ultimat3/core';
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

/**
 * A stack's FRAMES and nothing else: every line that is a frame (`    at …`), none that is not.
 * The message is the first line — and, when it spans several, the lines after it until the first
 * frame — so keeping only frame-shaped lines drops all of it, whatever it held. A frame is code
 * position, which carries no caller data.
 */
const FRAME = /^\s+at\s/;

function framesOf(error: unknown): string | null {
  const stack = stringField(error, 'stack');
  if (stack === undefined) return null;
  const lines = stack.split('\n');
  // Skip to the first frame line that FOLLOWS the message: a message may itself contain text
  // shaped like a frame, and only lines after the message block are the stack.
  const message = stringField(error, 'message') ?? '';
  const skip = message === '' ? 1 : message.split('\n').length;
  const frames = lines.slice(skip).filter((line) => FRAME.test(line));
  return frames.length === 0 ? null : frames.join('\n');
}

/**
 * The withheld half, logged as FACTS ONLY — the code, the error's name, and its frames. Never the
 * message and never the cause: the logger redacts by field NAME, not by content, so a pg
 * `Key (email)=(ceo@corp.com)` logged as text reached the logs whole. What identifies the failure
 * is the code and where it was thrown, both of which survive this.
 */
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
    // `name`, read structurally: what kind of throw it was (`Error`, `TypeError`, a driver's own).
    name: stringField(error, 'name') ?? typeof error,
    frames: framesOf(error),
  });
  return { code, cause: undefined, fix };
}
