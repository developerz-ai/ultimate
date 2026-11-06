// Single responsibility: render a mail's declared preview in one locale, with no flow triggered
// and nothing sent — what `x mail preview`, the `/_x` mail panel and `x verify`'s `i18n` step read.
// A miss is reported, never refused: a preview exists to show it.

import type { TranslationMiss } from '@ultimat3/i18n';
import type { MailMessage } from './driver';
import { templateUnknown } from './errors';
import { type MailDefinition, mailFor, registeredMailIds, renderWithMisses } from './mail';
import { assertPreview, previewMissing } from './preview-check';

/** A recipient no transport can reach: a preview is never a send. */
export const PREVIEW_RECIPIENT = 'preview@preview.invalid';

export interface MailPreviewResult {
  readonly id: string;
  readonly locale: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Every catalog key the render could not resolve in this locale: `send` would refuse these. */
  readonly misses: readonly TranslationMiss[];
}

export interface PreviewOptions {
  readonly locale: string;
  /** IANA zone for every date in the body. Default: the request context, then UTC. */
  readonly tz?: string | undefined;
}

/** Ids of every registered mail that declares a preview, in the registry's order. */
export function previewableMailIds(): readonly string[] {
  return registeredMailIds().filter((id) => mailFor(id)?.preview !== undefined);
}

export function previewMail(id: string, options: PreviewOptions): MailPreviewResult {
  const mail = mailFor(id);
  if (mail === undefined) throw templateUnknown(id, registeredMailIds());
  const declared = mail.preview;
  if (declared === undefined) throw previewMissing(id);
  const raw: unknown =
    typeof declared === 'function'
      ? Reflect.apply(declared, undefined, [options.locale])
      : declared;
  const data = assertPreview(id, mail.input, raw);
  // The registry erases the payload type; `data` was just parsed by this mail's own schema.
  const typed = mail as unknown as MailDefinition<unknown>;
  const { message, misses } = renderWithMisses(typed, data, {
    to: PREVIEW_RECIPIENT,
    locale: options.locale,
    ...(options.tz === undefined ? {} : { tz: options.tz }),
  });
  return resultOf(message, misses);
}

const resultOf = (message: MailMessage, misses: readonly TranslationMiss[]): MailPreviewResult => ({
  id: message.mailId,
  locale: message.locale,
  subject: message.subject,
  html: message.html,
  text: message.text,
  misses,
});
