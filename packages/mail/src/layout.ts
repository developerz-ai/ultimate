// Single responsibility: the base email layout and the semantic colour tokens every block
// resolves through. Colours are declared once here (light + dark) and inlined by the
// renderer, because email clients drop <style> and templates must never carry a raw hex.
// Table-based and 600px wide: Outlook still renders with Word's HTML engine.

import { escapeHtml, safeUrl, styleAttr } from './html';

export type ColorScheme = 'light' | 'dark';

export type MailToken =
  | 'pageBg'
  | 'surfaceBg'
  | 'textPrimary'
  | 'textMuted'
  | 'borderSubtle'
  | 'accentBg'
  | 'accentText'
  | 'linkText'
  | 'calloutInfoBg'
  | 'calloutInfoText'
  | 'calloutDangerBg'
  | 'calloutDangerText';

export const MAIL_TOKENS: Readonly<Record<MailToken, Readonly<Record<ColorScheme, string>>>> =
  Object.freeze({
    pageBg: { light: '#f4f5f7', dark: '#0b0d10' },
    surfaceBg: { light: '#ffffff', dark: '#14181d' },
    textPrimary: { light: '#16191d', dark: '#e7eaee' },
    textMuted: { light: '#5c6470', dark: '#9aa4b1' },
    borderSubtle: { light: '#e2e6ea', dark: '#262c33' },
    accentBg: { light: '#2f6df6', dark: '#4f86ff' },
    accentText: { light: '#ffffff', dark: '#0b0d10' },
    linkText: { light: '#2f6df6', dark: '#7aa7ff' },
    calloutInfoBg: { light: '#eef3ff', dark: '#141c2c' },
    calloutInfoText: { light: '#1f3f8f', dark: '#b9cdfb' },
    calloutDangerBg: { light: '#fdeceb', dark: '#2a1416' },
    calloutDangerText: { light: '#8c2118', dark: '#f5b3ad' },
  });

/** Resolve a token to a hex value. The only function in the package that returns a colour. */
export function token(name: MailToken, scheme: ColorScheme = 'light'): string {
  return MAIL_TOKENS[name][scheme];
}

export const MAIL_FONT_STACK =
  '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

export const MAIL_WIDTH_PX = 600;

/** A node's dark-mode role: which CSS property takes which token when the client is dark. */
export type DarkRule = readonly [role: string, declarations: readonly [string, MailToken][]];

/**
 * Dark overrides key off short `data-x` role codes rather than class names: base styling
 * stays fully inlined for the clients that strip <style>, and the codes are deliberately
 * not token names, so nothing leaks the design vocabulary into delivered HTML.
 */
export const DARK_RULES: readonly DarkRule[] = [
  ['page', [['background-color', 'pageBg']]],
  [
    'card',
    [
      ['background-color', 'surfaceBg'],
      ['border-color', 'borderSubtle'],
    ],
  ],
  ['h', [['color', 'textPrimary']]],
  ['p', [['color', 'textPrimary']]],
  ['mut', [['color', 'textMuted']]],
  [
    'btn',
    [
      ['background-color', 'accentBg'],
      ['color', 'accentText'],
    ],
  ],
  ['hr', [['border-top-color', 'borderSubtle']]],
  ['a', [['color', 'linkText']]],
  [
    'ci',
    [
      ['background-color', 'calloutInfoBg'],
      ['color', 'calloutInfoText'],
    ],
  ],
  [
    'cd',
    [
      ['background-color', 'calloutDangerBg'],
      ['color', 'calloutDangerText'],
    ],
  ],
];

/** The one `prefers-color-scheme` block. Clients that ignore it keep the inlined light theme. */
export function darkModeCss(): string {
  const rules = DARK_RULES.map(([role, declarations]) => {
    const body = declarations
      .map(([property, name]) => `${property}:${token(name, 'dark')}!important`)
      .join(';');
    return `[data-x="${role}"]{${body}}`;
  });
  return `@media (prefers-color-scheme:dark){${rules.join('')}}`;
}

export interface UnsubscribeSlot {
  /** Already translated — the layout never touches a catalog. */
  readonly label: string;
  readonly url: string;
}

export interface LayoutInput {
  readonly subject: string;
  /** Hidden preview text. Clients show it next to the subject in the inbox list. */
  readonly preheader: string;
  /** Rendered block HTML. */
  readonly content: string;
  readonly footer: readonly string[];
  readonly unsubscribe?: UnsubscribeSlot | undefined;
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl';
}

export type MailLayout = (input: LayoutInput) => string;

export const BASE_LAYOUT = 'base';

const BODY_STYLE = styleAttr([
  'margin:0',
  'padding:0',
  'width:100%',
  `background-color:${token('pageBg')}`,
  `font-family:${MAIL_FONT_STACK}`,
  `color:${token('textPrimary')}`,
  '-webkit-font-smoothing:antialiased',
]);

const PREHEADER_STYLE = styleAttr([
  'display:none',
  'font-size:1px',
  'line-height:1px',
  'max-height:0',
  'max-width:0',
  'opacity:0',
  'overflow:hidden',
  'mso-hide:all',
]);

const PAGE_STYLE = styleAttr([`background-color:${token('pageBg')}`, 'width:100%']);
const GUTTER_STYLE = styleAttr(['padding:24px 12px']);
const SHELL_STYLE = styleAttr([`width:${MAIL_WIDTH_PX}px`, 'max-width:100%']);

const CARD_STYLE = styleAttr([
  `background-color:${token('surfaceBg')}`,
  `border:1px solid ${token('borderSubtle')}`,
  'border-radius:12px',
  'padding:32px',
]);

const FOOTER_STYLE = styleAttr([
  `color:${token('textMuted')}`,
  'font-size:12px',
  'line-height:18px',
  'padding:16px 8px 32px 8px',
]);

const UNSUBSCRIBE_STYLE = styleAttr([`color:${token('textMuted')}`, 'text-decoration:underline']);

const TABLE_ATTRS = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/** The framework's only layout. Apps register their own with `registerLayout`. */
export const baseLayout: MailLayout = (input) => `<!doctype html>
<html lang="${escapeHtml(input.locale)}" dir="${input.direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.subject)}</title>
<style>${darkModeCss()}</style>
</head>
<body ${BODY_STYLE} data-x="page">
<div ${PREHEADER_STYLE}>${escapeHtml(input.preheader)}</div>
<table ${TABLE_ATTRS} width="100%" data-x="page" ${PAGE_STYLE}>
<tr><td align="center" ${GUTTER_STYLE}>
<table ${TABLE_ATTRS} width="${MAIL_WIDTH_PX}" ${SHELL_STYLE}>
<tr><td data-x="card" ${CARD_STYLE}>${input.content}</td></tr>
<tr><td data-x="mut" ${FOOTER_STYLE}>${footerHtml(input)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

function footerHtml(input: LayoutInput): string {
  const lines = input.footer.map((line) => `<div>${escapeHtml(line)}</div>`);
  const slot = input.unsubscribe;
  if (slot !== undefined) {
    const href = escapeHtml(safeUrl(slot.url));
    const label = escapeHtml(slot.label);
    lines.push(`<div><a data-x="a" href="${href}" ${UNSUBSCRIBE_STYLE}>${label}</a></div>`);
  }
  return lines.join('');
}

const layouts = new Map<string, MailLayout>([[BASE_LAYOUT, baseLayout]]);

export function registerLayout(name: string, layout: MailLayout): void {
  layouts.set(name, layout);
}

export function layoutFor(name: string): MailLayout | undefined {
  return layouts.get(name);
}

export function registeredLayouts(): readonly string[] {
  return [...layouts.keys()].sort();
}
