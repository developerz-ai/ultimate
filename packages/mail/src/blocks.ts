// Single responsibility: the vocabulary a template writes in. A mail body is a list of blocks
// carrying i18n KEYS, never markup and never a colour — that is what makes one template able
// to produce an HTML part and a text part, and what keeps translation out of the renderer.

import type { TranslateVars, Translator } from '@ultimat3/i18n';

export type CalloutTone = 'info' | 'danger';

export type MailBlock =
  | { readonly kind: 'heading'; readonly key: string; readonly vars?: TranslateVars | undefined }
  | { readonly kind: 'paragraph'; readonly key: string; readonly vars?: TranslateVars | undefined }
  | {
      readonly kind: 'button';
      readonly key: string;
      readonly href: string;
      readonly vars?: TranslateVars | undefined;
    }
  | {
      readonly kind: 'callout';
      readonly key: string;
      readonly tone: CalloutTone;
      readonly vars?: TranslateVars | undefined;
    }
  /** A label key plus an already-localised value (a date, an IP, a method name). */
  | { readonly kind: 'detail'; readonly key: string; readonly value: string }
  | { readonly kind: 'divider' };

/** Block constructors, so a template never hand-writes an object literal or a colour. */
export const blocks = Object.freeze({
  heading: (key: string, vars?: TranslateVars): MailBlock => ({ kind: 'heading', key, vars }),
  paragraph: (key: string, vars?: TranslateVars): MailBlock => ({ kind: 'paragraph', key, vars }),
  button: (key: string, href: string, vars?: TranslateVars): MailBlock => ({
    kind: 'button',
    key,
    href,
    vars,
  }),
  callout: (key: string, tone: CalloutTone, vars?: TranslateVars): MailBlock => ({
    kind: 'callout',
    key,
    tone,
    vars,
  }),
  detail: (key: string, value: string): MailBlock => ({ kind: 'detail', key, value }),
  divider: (): MailBlock => ({ kind: 'divider' }),
});

export interface TemplateArgs<I> {
  readonly data: I;
  readonly t: Translator;
  readonly locale: string;
  /** IANA zone. Every date in a mail is formatted with it — never with the server's zone. */
  readonly tz: string;
}

export type MailTemplate<I> = (args: TemplateArgs<I>) => readonly MailBlock[];
