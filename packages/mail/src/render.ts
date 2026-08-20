// Single responsibility: turn a template's block list into BOTH an HTML part and a plain-text
// part. One source of truth per mail — the text is derived from the blocks, never scraped back
// out of the HTML, so it never rots. Styling is inlined from the layout's tokens because most
// clients drop <style>; the dark-mode block is the one exception, for clients that honour it.

import { directionOf, type TranslateVars, type Translator, translatorFor } from '@ultimat3/i18n';
import type { CalloutTone, MailBlock, MailTemplate } from './blocks';
// The renderer depends on the strings it renders. This is the only module that resolves a `mail.*`
// key, and `catalog.ts` installs them at ITS module scope — so importing it here is what makes
// "a rendered mail has words in it" structural rather than something a caller has to arrange.
// Without this edge, only the package ENTRY reached the catalog: every deep import of `render.ts`
// produced `⟦mail.welcome.subject⟧`, and the tests that would have noticed were the ones calling
// `registerMailCatalog()` themselves — the exact shape of issue #249.
import './catalog';
import { layoutUnknown, textMissing } from './errors';
import { escapeHtml, safeUrl, styleAttr } from './html';
import { layoutFor, registeredLayouts, token } from './layout';

/** What the renderer needs from a mail. `MailDefinition` adds the input schema on top. */
export interface RenderableMail<I> {
  readonly id: string;
  readonly subject: string;
  readonly template: MailTemplate<I>;
  readonly layout: string;
}

export interface RenderOptions {
  readonly locale: string;
  readonly tz: string;
  readonly unsubscribeUrl?: string | undefined;
}

export interface RenderedMail {
  readonly subject: string;
  readonly preheader: string;
  readonly html: string;
  readonly text: string;
}

export const FOOTER_KEYS = ['mail.footer.legal', 'mail.footer.help'] as const;
export const UNSUBSCRIBE_KEY = 'mail.footer.unsubscribe';

export function renderMail<I>(
  mail: RenderableMail<I>,
  data: I,
  options: RenderOptions,
): RenderedMail {
  const layout = layoutFor(mail.layout);
  if (layout === undefined) throw layoutUnknown(mail.id, mail.layout, registeredLayouts());

  const t = translatorFor(options.locale);
  const vars = toVars(data);
  const subject = t(mail.subject, vars);
  const preheaderKey = `mail.${mail.id}.preheader`;
  const preheader = t.has(preheaderKey) ? t(preheaderKey, vars) : subject;

  const list = mail.template({ data, t, locale: options.locale, tz: options.tz });
  const bodyText = textOf(list, t);
  if (bodyText.trim() === '') throw textMissing(mail.id);

  const footer = FOOTER_KEYS.filter((key) => t.has(key)).map((key) => t(key, vars));
  const unsubscribe =
    options.unsubscribeUrl === undefined
      ? undefined
      : { label: t(UNSUBSCRIBE_KEY), url: options.unsubscribeUrl };

  const html = layout({
    subject,
    preheader,
    content: list.map((block) => htmlOf(block, t)).join(''),
    footer,
    unsubscribe,
    locale: options.locale,
    direction: directionOf(options.locale),
  });

  const tail = [...footer];
  if (unsubscribe !== undefined) tail.push(`${unsubscribe.label}: ${safeUrl(unsubscribe.url)}`);
  const text = tail.length === 0 ? bodyText : `${bodyText}\n\n--\n${tail.join('\n')}`;

  return { subject, preheader, html, text };
}

/** The text part, block by block. Never derived from the HTML. */
export function textOf(list: readonly MailBlock[], t: Translator): string {
  const lines: string[] = [];
  for (const block of list) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
      case 'callout':
        lines.push(t(block.key, block.vars));
        break;
      case 'button':
        lines.push(`${t(block.key, block.vars)}: ${safeUrl(block.href)}`);
        break;
      case 'detail':
        lines.push(`${t(block.key)}: ${block.value}`);
        break;
      case 'divider':
        break;
    }
  }
  return lines.join('\n\n');
}

const HEADING_STYLE = styleAttr([
  'margin:0 0 16px 0',
  'font-size:24px',
  'line-height:32px',
  'font-weight:600',
  `color:${token('textPrimary')}`,
]);

const PARAGRAPH_STYLE = styleAttr([
  'margin:0 0 16px 0',
  'font-size:16px',
  'line-height:24px',
  `color:${token('textPrimary')}`,
]);

const DETAIL_LABEL_STYLE = styleAttr([`color:${token('textMuted')}`, 'font-size:14px']);

const BUTTON_LINK_STYLE = styleAttr([
  'display:inline-block',
  'padding:12px 22px',
  'font-size:16px',
  'font-weight:600',
  'text-decoration:none',
  `color:${token('accentText')}`,
  `background-color:${token('accentBg')}`,
  'border-radius:8px',
]);

const DIVIDER_STYLE = styleAttr([
  `border-top:1px solid ${token('borderSubtle')}`,
  'font-size:0',
  'line-height:0',
  'height:1px',
  'padding:8px 0 0 0',
]);

const TABLE_ATTRS = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function calloutStyle(tone: CalloutTone): string {
  const bg = tone === 'danger' ? token('calloutDangerBg') : token('calloutInfoBg');
  const fg = tone === 'danger' ? token('calloutDangerText') : token('calloutInfoText');
  return styleAttr([
    `background-color:${bg}`,
    `color:${fg}`,
    'padding:16px',
    'border-radius:8px',
    'font-size:15px',
    'line-height:22px',
  ]);
}

function htmlOf(block: MailBlock, t: Translator): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 data-x="h" ${HEADING_STYLE}>${escapeHtml(t(block.key, block.vars))}</h1>`;
    case 'paragraph':
      return `<p data-x="p" ${PARAGRAPH_STYLE}>${escapeHtml(t(block.key, block.vars))}</p>`;
    case 'button': {
      const href = escapeHtml(safeUrl(block.href));
      const label = escapeHtml(t(block.key, block.vars));
      const anchor = `<a data-x="btn" href="${href}" ${BUTTON_LINK_STYLE}>${label}</a>`;
      return `<table ${TABLE_ATTRS}><tr><td>${anchor}</td></tr></table>`;
    }
    case 'callout': {
      const role = block.tone === 'danger' ? 'cd' : 'ci';
      const body = escapeHtml(t(block.key, block.vars));
      const cell = `<td data-x="${role}" ${calloutStyle(block.tone)}>${body}</td>`;
      return `<table ${TABLE_ATTRS} width="100%"><tr>${cell}</tr></table>`;
    }
    case 'detail': {
      const label = `<span data-x="mut" ${DETAIL_LABEL_STYLE}>${escapeHtml(t(block.key))}</span>`;
      return `<p data-x="p" ${PARAGRAPH_STYLE}>${label} ${escapeHtml(block.value)}</p>`;
    }
    case 'divider': {
      const cell = `<td data-x="hr" ${DIVIDER_STYLE}></td>`;
      return `<table ${TABLE_ATTRS} width="100%"><tr>${cell}</tr></table>`;
    }
  }
}

/** Scalar fields of the payload become interpolation vars; Dates and objects never do. */
function toVars(data: unknown): TranslateVars {
  const vars: TranslateVars = {};
  if (typeof data !== 'object' || data === null) return vars;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      vars[key] = value;
    }
  }
  return vars;
}
