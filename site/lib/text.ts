// The text primitives every other stage builds on: HTML escaping, heading slugs, `{{var}}`
// template fills, and frontmatter parsing.

export const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

export const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');

export function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  if (!src.startsWith('---\n')) return { meta: {}, body: src };
  const end = src.indexOf('\n---', 4);
  const meta: Record<string, string> = {};
  for (const line of src.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    meta[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: src.slice(end + 4).replace(/^\n+/, '') };
}
