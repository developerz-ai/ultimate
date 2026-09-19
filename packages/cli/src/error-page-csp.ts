// The `style-src` sources that admit an app's own error pages. `error-pages.ts` serves
// `apps/web/site/errors/<status>.html` verbatim, and such a page is a self-contained document —
// it carries its own `<style>`, because the app's stylesheet bundle is not linked from it. Under
// the enforced policy a container sends, `style-src 'self' <overlay hash>` blocked that block and
// the page rendered unstyled; `x dev` sends the policy report-only, so the same page looked fine
// on every author's machine. Hashed at boot, like the hydration runtime: a hash is a function of
// the body, and these files do not change while a container runs.

// why: Bun exposes no path-join primitive, and the directory is app-root-relative — the same
// necessity `error-pages.ts` records.
import { join } from 'node:path';
import { cspHashSource } from '@ultimat3/http';
import { ERROR_PAGE_DIR } from './error-pages';

/**
 * `<style>` bodies, in document order, exactly as the browser will hash them: the text between
 * the tags, untrimmed. A trimmed body hashes to a different value and admits nothing.
 */
export function inlineStyleBodies(html: string): readonly string[] {
  const bodies: string[] = [];
  const pattern = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

/**
 * One hash per distinct `<style>` body across every error page the app ships. Read once at boot:
 * a page an author drops in while `x dev` runs is served (the reader is per request) but not yet
 * admitted, which the report-only policy there turns into a console report, not a blank page.
 */
export async function errorPageStyleSources(root: string): Promise<readonly string[]> {
  const dir = join(root, ERROR_PAGE_DIR);
  const sources = new Set<string>();
  for (const name of await htmlFilesIn(dir)) {
    const html = await Bun.file(join(dir, name)).text();
    for (const body of inlineStyleBodies(html)) sources.add(cspHashSource(body));
  }
  return [...sources].sort();
}

/** `Bun.Glob.scan` throws `ENOENT` on a missing directory, and no error pages is the common case. */
async function htmlFilesIn(dir: string): Promise<readonly string[]> {
  try {
    return (await Array.fromAsync(new Bun.Glob('*.html').scan({ cwd: dir }))).sort();
  } catch {
    return [];
  }
}
