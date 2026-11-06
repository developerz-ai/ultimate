// Single responsibility: every declared mail preview rendered in every shipped locale, as `x verify`'s
// `i18n` step findings — so a preview is a test too: a key a locale lacks, or a preview its own
// schema refuses, is red at the gate instead of in a customer's inbox.

import { mailKeyMissing, previewableMailIds, previewMail } from '@ultimat3/mail';
import type { Finding } from './output';
import { findingFrom } from './output';

export function mailPreviewFindings(locales: readonly string[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const id of previewableMailIds()) {
    for (const locale of locales) {
      try {
        const preview = previewMail(id, { locale });
        if (preview.misses.length > 0) {
          findings.push(findingFrom(mailKeyMissing(id, locale, preview.misses)));
        }
      } catch (error) {
        findings.push(findingFrom(error));
      }
    }
  }
  return findings;
}
