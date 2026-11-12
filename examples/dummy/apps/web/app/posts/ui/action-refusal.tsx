/**
 * The refusal a native form's answer left for this page (`useActionAnswer`, read in the route's
 * `load`), as one translated sentence. The flash carries a stable code and no prose, so the words
 * are this app's: a code it names gets its own line, any other the general one.
 */

import type { TranslationKey } from '@postly/i18n';
import { useT } from '@postly/i18n';
import type { ActionAnswer } from '@ultimat3/action';
import { Alert } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

/** The codes the posts forms can be refused with that deserve more than the general line. */
const REFUSALS: Readonly<Record<string, TranslationKey>> = {
  X_INPUT_INVALID: 'errors.formInvalid',
  X_FORBIDDEN: 'errors.policyDenied',
  X_POST_NOT_FOUND: 'errors.postNotFound',
  X_POST_SLUG_TAKEN: 'errors.postSlugTaken',
  X_METER_EXCEEDED: 'errors.meterExceeded',
  X_RATE_LIMITED: 'errors.rateLimited',
};

/** The catalog key a refusal's code reads as. */
export const refusalKey = (code: string): TranslationKey =>
  Object.hasOwn(REFUSALS, code) ? (REFUSALS[code] ?? 'errors.formRefused') : 'errors.formRefused';

/** Nothing for no answer or a success — the page it landed on IS the success. */
export function ActionRefusal(props: {
  readonly answer: ActionAnswer | null | undefined;
}): JSX.Element {
  const t = useT();
  const answer = props.answer;
  if (answer?.outcome !== 'refusal') return null;
  return <Alert tone="danger">{t(refusalKey(answer.code))}</Alert>;
}
