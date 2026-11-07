// Single responsibility: the export, served on loopback for the length of a card capture — the
// dumb file server a CDN is, so a card page is photographed with exactly the stylesheet, fonts and
// assets the published page links. Never the app: a static export has no process behind it.

// why: Bun exposes no path-join primitive, and every file served is relative to the export root.
import { join, normalize, sep } from 'node:path';

export interface ServedExport {
  readonly origin: string;
  stop(): void;
}

/** `/og/home` → `og/home/index.html`, then the bare file — the two shapes an export holds. */
function fileFor(out: string, pathname: string): readonly string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return [];
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (relative.split(sep).includes('..')) return [];
  return [join(out, relative, 'index.html'), join(out, relative)];
}

export function serveExport(out: string): ServedExport {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      for (const file of fileFor(out, new URL(request.url).pathname)) {
        const body = Bun.file(file);
        if (await body.exists()) return new Response(body);
      }
      return new Response(null, { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${String(server.port)}`, stop: () => void server.stop(true) };
}
