// A finding's `at` (`path:line`) read back as the two halves an `edit <file>:<line> — …` fix opens
// with — the fix-line scan reads that shape off the template, so the halves are spliced apart.

export interface SiteAt {
  readonly path: string;
  readonly line: string;
}

/** `wiki/A.md:12` → `{ path: 'wiki/A.md', line: '12' }`; an `at` with no line names the file's top. */
export function siteAt(at: string): SiteAt {
  const cut = at.lastIndexOf(':');
  const line = at.slice(cut + 1);
  return cut > 0 && /^\d+$/.test(line) ? { path: at.slice(0, cut), line } : { path: at, line: '1' };
}
