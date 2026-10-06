// The inline `<style>` bodies of an app's own error pages, for `style-src` to admit. Such a page
// (`apps/web/site/errors/<status>.html`, served verbatim by `error-pages.ts`) carries its own
// `<style>` — no stylesheet bundle is linked from it — and under the container's enforced policy an
// unadmitted block is a page rendered unstyled; `x dev` is report-only, so it looked fine there.

// why: Bun exposes no path-join primitive, and the directory is app-root-relative — the same
// necessity `error-pages.ts` records.
import { join } from 'node:path';
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
 * Every distinct `<style>` body across every error page the app ships, sorted — BODIES, because
 * `startRoles({ inlineStyles })` hashes what it is given (`style-csp.ts`). This returned the hashes
 * until 2026-10, and the boot hashed them again: the policy admitted the hash of a hash, and every
 * app error page carrying a `<style>` rendered unstyled under the container's enforced CSP. Read
 * once at boot: a page an author drops in while `x dev` runs is served (the reader is per request)
 * but not yet admitted, which the report-only policy there turns into a console report.
 */
export async function errorPageStyleBodies(root: string): Promise<readonly string[]> {
  const dir = join(root, ERROR_PAGE_DIR);
  const bodies = new Set<string>();
  for (const name of await htmlFilesIn(dir)) {
    const html = await Bun.file(join(dir, name)).text();
    for (const body of inlineStyleBodies(html)) bodies.add(body);
  }
  return [...bodies].sort();
}

/** `Bun.Glob.scan` throws `ENOENT` on a missing directory, and no error pages is the common case. */
async function htmlFilesIn(dir: string): Promise<readonly string[]> {
  try {
    return (await Array.fromAsync(new Bun.Glob('*.html').scan({ cwd: dir }))).sort();
  } catch {
    return [];
  }
}
