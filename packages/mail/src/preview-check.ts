// Single responsibility: a mail's declared preview held to its own input schema — the one data a
// person checks a template by must be data the mail could really be sent with.

import { isUltimateError, renderFixShellArg, renderThrowable } from '@ultimat3/core';
import { parse, type StandardSchemaV1 } from '@ultimat3/schema';
import { MailError } from './errors';

/** The parsed preview, or `X_MAIL_PREVIEW_INVALID` naming the schema's own words. */
export function assertPreview<I>(
  mailId: string,
  input: StandardSchemaV1<unknown, I>,
  data: unknown,
): I {
  try {
    return parse(input, data, `${mailId}.preview`);
  } catch (error) {
    const reason = isUltimateError(error) ? error.cause : renderThrowable(error);
    throw new MailError({
      code: 'X_MAIL_PREVIEW_INVALID',
      cause: `the preview declared for mail "${mailId}" fails its input schema: ${reason}`,
      fix: `x mail preview ${renderFixShellArg(mailId, '<mail-id>')} --json   # then correct preview in the defineMail({ id: '${mailId}' }) call to match its input`,
      meta: { mailId },
    });
  }
}

/** A preview asked of a mail that declares none. */
export const previewMissing = (mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_PREVIEW_MISSING',
    cause: `mail "${mailId}" declares no preview, so there is no data to render it with`,
    fix: `x mail preview ${renderFixShellArg(mailId, '<mail-id>')} --json   # after adding preview: { ... } to its defineMail({ id: '${mailId}' }) call, shaped like its input`,
    meta: { mailId },
  });
