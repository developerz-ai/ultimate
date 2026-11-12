// The refusal a native form's answer left for this page (`useActionAnswer`, read in the route's
// `load`), as one translated sentence. The flash carries a stable code and no prose, so the words
// are this app's: a code it names gets its own line, any other the general one.

import type { ActionAnswer } from '@ultimat3/action';
import { t } from '@ultimat3/i18n';
import { Alert } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

/** The codes this app's forms are refused with that deserve more than the general line. */
export const REFUSALS: Readonly<Record<string, string>> = {
  X_INPUT_INVALID: 'refusal.invalid',
  X_AUTH_CREDENTIALS_INVALID: 'refusal.credentials',
  X_AUTH_CAPTCHA_FAILED: 'refusal.captcha',
  X_AUTH_HANDLE_TAKEN: 'refusal.handleTaken',
  X_AUTH_EMAIL_TAKEN: 'refusal.emailTaken',
  X_INVARIANT_VIOLATED: 'refusal.invalid',
  X_NOT_A_PARTICIPANT: 'refusal.notParticipant',
  X_FORBIDDEN: 'refusal.forbidden',
  X_RATE_LIMITED: 'refusal.rateLimited',
};

/** The catalog key a refusal's code reads as. */
export const refusalKey = (code: string): string =>
  (Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined) ?? 'refusal.general';

/** Nothing for no answer or a success — the page it landed on IS the success. */
export function ActionRefusal(props: {
  readonly answer: ActionAnswer | null | undefined;
}): JSX.Element {
  const answer = props.answer;
  if (answer?.outcome !== 'refusal') return null;
  return <Alert tone="danger">{t(refusalKey(answer.code))}</Alert>;
}
