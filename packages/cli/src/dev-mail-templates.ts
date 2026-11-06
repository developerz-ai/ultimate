// The `/_x` mail panel's templates source: every registered mail, its declared `preview` rendered
// in each of the app's locales by `@ultimat3/mail`'s `previewMail` — the same render
// `x mail preview` prints. Dates in a preview render in UTC, named: there is no ambient zone.

import type { MailTemplateFact, MailTemplatePreviewFact } from '@ultimat3/admin/dev';
import { InternalError, renderFixShellArg, renderThrowable, stringField } from '@ultimat3/core';
import { mailFor, previewMail, registeredMailIds } from '@ultimat3/mail';

/** The zone a preview's dates render in: a sample has no reader, so no reader's zone. */
const PREVIEW_ZONE = 'UTC';

export function mailTemplateFacts(locales: readonly string[]): readonly MailTemplateFact[] {
  return registeredMailIds().map((id) => {
    const hasPreview = mailFor(id)?.preview !== undefined;
    return {
      id,
      hasPreview,
      previews: hasPreview ? locales.map((locale) => previewIn(id, locale)) : [],
    };
  });
}

/**
 * A preview function's data is parsed at each render, so one locale's can be refused while the
 * others render: that refusal is this cell's, shown with its fix, never the whole panel's.
 */
function previewIn(id: string, locale: string): MailTemplatePreviewFact {
  try {
    const preview = previewMail(id, { locale, tz: PREVIEW_ZONE });
    return {
      locale,
      ok: true,
      subject: preview.subject,
      html: preview.html,
      text: preview.text,
      missing: preview.misses.map((miss) => miss.key),
    };
  } catch (error) {
    return {
      locale,
      ok: false,
      error: {
        code: stringField(error, 'code') ?? InternalError.code,
        cause: stringField(error, 'cause') ?? renderThrowable(error),
        fix:
          stringField(error, 'fix') ??
          `x mail preview ${renderFixShellArg(id, '<mail-id>')} --locale ${renderFixShellArg(locale, '<locale>')} --json`,
      },
    };
  }
}
