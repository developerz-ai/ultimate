// Panel: Mail.
// Kills: "what did that email actually look like, in that locale?" — every caught message, and
// every declared template rendered from its `preview` in every locale with no flow triggered.

import type { MailFact, MailTemplateFact } from './facts';
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
  /** Every declared mail, each with its preview rendered per locale (`defineMail({ preview })`). */
  readonly templates: readonly MailTemplateFact[];
  readonly selectedTemplate: MailTemplateFact | null;
  /** A template's catalog keys a locale could not resolve — the gap before anything is sent. */
  readonly templateGaps: readonly {
    readonly id: string;
    readonly locale: string;
    readonly missing: readonly string[];
  }[];
}

/** `?template=` names one; none named is the first; an unknown name is nothing, never the first. */
const selectedOf = (
  templates: readonly MailTemplateFact[],
  wanted: string | null,
): MailTemplateFact | null =>
  (wanted === null ? templates[0] : templates.find((one) => one.id === wanted)) ?? null;

export const mailPanel: DevPanel<MailPanelData> = {
  key: 'mail',
  titleKey: 'dev.panel.mail.title',
  questionKey: 'dev.panel.mail.question',
  async data(sources, params): Promise<MailPanelData> {
    const [all, templates] = await Promise.all([sources.mail(), sources.mailTemplates()]);
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
      templates,
      selectedTemplate: selectedOf(templates, params.get('template')),
      templateGaps: templates.flatMap((template) =>
        template.previews.flatMap((preview) =>
          preview.ok && preview.missing.length > 0
            ? [{ id: template.id, locale: preview.locale, missing: preview.missing }]
            : [],
        ),
      ),
    };
  },
};
