// Single responsibility: a pinned HTTP primitive's request shape — the URL with every `:param`
// filled (`fillTemplate`), and the input WITHOUT those keys, which the URL carries. The one split
// `@ultimat3/action`'s client, `@ultimat3/query`'s client and `@ultimat3/realtime`'s writes share;
// each refuses an unfillable param with its own code. Imports only the template module.

import { fillTemplate, templateParams } from './route-path-template';

export type FilledWire =
  | {
      readonly ok: true;
      /** The path, filled — no base, no search string: the caller adds its own. */
      readonly url: string;
      /** The input minus the `:param` keys; for a static path, the input itself. */
      readonly rest: unknown;
    }
  | { readonly ok: false; readonly missing: string; readonly reason: string };

export function fillWire(path: string, input: unknown): FilledWire {
  const params = templateParams(path);
  if (params.length === 0) return { ok: true, url: path, rest: input };
  const filled = fillTemplate(path, input);
  if (!filled.ok) return filled;
  // `fillTemplate` read a string from every param, so `input` is an object here.
  const entries = Object.entries(input as Readonly<Record<string, unknown>>);
  return {
    ok: true,
    url: filled.path,
    rest: Object.fromEntries(entries.filter(([key]) => !params.includes(key))),
  };
}
