// Single responsibility: the mail-specific half of making untrusted values inert — which URLs a
// link may carry and how a style attribute is written. The character escaping is core's
// `escapeHtml`, the one table: an unescaped name in a mail is a phishing vector forever.

import { escapeHtml } from '@ultimat3/core';

const SAFE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

/**
 * `javascript:` and `data:` hrefs are stripped rather than escaped: some clients still
 * follow them, and a link the recipient cannot trust is worse than a dead one.
 */
export function safeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '#';
  }
  return SAFE_PROTOCOLS.includes(parsed.protocol) ? parsed.href : '#';
}

/** `style="a:b;c:d"` from declarations, so no call site hand-builds a style attribute. */
export function styleAttr(declarations: readonly string[]): string {
  return `style="${escapeHtml(declarations.join(';'))}"`;
}
