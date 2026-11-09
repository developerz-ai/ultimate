// The code and the reason a surface-shaped denial carries, read back out of whichever shape the
// adapter rendered. Here once: `@ultimat3/action` and `@ultimat3/query` each kept a copy, and both
// copies read an MCP denial's whole text as its reason, so the cause said the code twice.

import { assertNever } from '@ultimat3/core';
import type { SurfaceDenial } from './surfaces';

/** The `X_*` code the policy decided with — the same one on every surface. */
export function denialCode(denial: SurfaceDenial): string {
  switch (denial.surface) {
    case 'http':
      return denial.problem.code;
    case 'live':
    case 'job':
      return denial.code;
    case 'mcp':
      return mcpParts(denial.content[0]?.text).code;
    default:
      return assertNever(denial);
  }
}

/** The policy's reason, safe to log by construction — never prefixed with the code. */
export function denialReason(denial: SurfaceDenial): string {
  switch (denial.surface) {
    case 'http':
      return denial.problem.detail;
    case 'live':
    case 'job':
      return denial.reason;
    case 'mcp':
      return mcpParts(denial.content[0]?.text).reason;
    default:
      return assertNever(denial);
  }
}

/**
 * `enforceMcp` writes `<code>: <reason>`, and a code never holds `': '`, so the first separator
 * splits it exactly. A text without one is a reason with no code: `X_FORBIDDEN`, the default
 * every adapter falls back to.
 */
function mcpParts(text: string | undefined): { readonly code: string; readonly reason: string } {
  if (text === undefined) return { code: 'X_FORBIDDEN', reason: 'denied' };
  const at = text.indexOf(': ');
  if (at <= 0) return { code: 'X_FORBIDDEN', reason: text };
  return { code: text.slice(0, at), reason: text.slice(at + 2) };
}
