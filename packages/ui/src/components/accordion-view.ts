// Which sections are expanded on first paint. A rule, not markup: `<details name>` is a radio
// group, so two open siblings is a state the browser silently resolves for you — deciding it
// here instead means the server and the browser agree on what the page looked like.

import { invalidValueError } from '../errors';

export interface AccordionSection {
  readonly id: string;
  readonly defaultOpen?: boolean | undefined;
}

/**
 * The open set. `exclusive` keeps the first requested section and closes the rest, because a
 * `name`-grouped `<details>` can only have one open member and the browser picks silently.
 */
export function accordionOpenIds(
  sections: readonly AccordionSection[],
  exclusive = false,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const open = new Set<string>();
  for (const section of sections) {
    if (seen.has(section.id)) {
      throw invalidValueError('Accordion', section.id, 'a unique item id — ids become element ids');
    }
    seen.add(section.id);
    if (section.defaultOpen !== true) continue;
    if (exclusive && open.size > 0) continue;
    open.add(section.id);
  }
  return open;
}
