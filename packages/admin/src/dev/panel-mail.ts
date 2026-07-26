// Panel: Mail.
// Kills: "what did that email actually look like, in that locale?" — every caught message,
// rendered, grouped per locale so a missing translation is visible instead of inferred.

import type { MailFact } from './facts';
import type { DevPanel } from './panel';

export interface MailPanelData {
  readonly messages: readonly MailFact[];
  readonly selected: MailFact | null;
  readonly locales: readonly string[];
  /** Subjects that exist in one locale but not another — a catalog gap, shown as one. */
  readonly missingLocales: readonly {
    readonly subject: string;
    readonly missing: readonly string[];
  }[];
}

export const mailPanel: DevPanel<MailPanelData> = {
  key: 'mail',
  titleKey: 'dev.panel.mail',
  question: 'what did that email look like, in that locale?',
  async data(sources, params): Promise<MailPanelData> {
    const all = await sources.mail();
    const locale = params.get('locale');
    const messages = locale === null ? all : all.filter((mail) => mail.locale === locale);
    const wanted = params.get('id');
    const selected =
      (wanted === null ? messages[0] : messages.find((mail) => mail.id === wanted)) ?? null;

    const locales = [...new Set(all.map((mail) => mail.locale))].sort();
    const bySubject = new Map<string, Set<string>>();
    for (const mail of all) {
      const seen = bySubject.get(mail.subject) ?? new Set<string>();
      seen.add(mail.locale);
      bySubject.set(mail.subject, seen);
    }

    return {
      messages,
      selected,
      locales,
      missingLocales: [...bySubject.entries()]
        .map(([subject, seen]) => ({
          subject,
          missing: locales.filter((candidate) => !seen.has(candidate)),
        }))
        .filter((entry) => entry.missing.length > 0),
    };
  },
};
