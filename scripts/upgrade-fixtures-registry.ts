// The `@ultimat3` scope on loopback, for a fixture's `.npmrc`: npm's packuments cut back to a past
// release (`asOf`), or npm's plus the working tree packed as one more release (`withHead`). So
// `x upgrade --to <HEAD>` resolves, installs and gates exactly as it will the day HEAD is on npm,
// and every dependency outside the scope still comes from npm itself.

// why: Bun has no directory listing, mkdir or recursive remove; the pack dir and cache are managed here.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { Finding } from './lib/log';
import { LONG_RUN_TIMEOUT_MS, run } from './lib/run';
import type { PackedPackage } from './upgrade-fixtures-packument';
import { asOf, packageOfPath, SCOPE, tarballName, withHead } from './upgrade-fixtures-packument';

export const UPSTREAM = 'https://registry.npmjs.org';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const integrityOf = async (file: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(await Bun.file(file).arrayBuffer());
  return `sha512-${hasher.digest('base64')}`;
};

/** Every publishable `@ultimat3/*` workspace under `root/packages`, packed into `dest`. */
export async function packHead(
  root: string,
  dest: string,
): Promise<{ readonly packed: readonly PackedPackage[]; readonly findings: readonly Finding[] }> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const packed: PackedPackage[] = [];
  const findings: Finding[] = [];
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const manifestFile = Bun.file(join(root, 'packages', dir, 'package.json'));
    if (!(await manifestFile.exists())) continue;
    const manifest: unknown = await manifestFile.json();
    if (!isRecord(manifest) || manifest['private'] === true) continue;
    const { name, version } = manifest;
    if (typeof name !== 'string' || !name.startsWith(`${SCOPE}/`) || typeof version !== 'string') {
      continue;
    }
    // The package's own pack, hooks included: the CLI's `prepack` copies the wiki in, as a release does.
    const result = await run(['bun', 'pm', 'pack', '--destination', dest, '--quiet'], {
      cwd: join(root, 'packages', dir),
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    const file = join(dest, tarballName(name, version));
    if (!result.ok || !(await Bun.file(file).exists())) {
      findings.push({
        code: 'X_UPGRADE_FIXTURE_UNBUILT',
        cause: `bun pm pack of ${name} exited ${String(result.code)}, so no fixture can install HEAD: ${result.output.slice(-400)}`,
        fix: `cd packages/${dir} && bun pm pack --destination /tmp/pack`,
        at: `packages/${dir}/package.json`,
      });
      continue;
    }
    packed.push({ name, version, manifest, file, integrity: await integrityOf(file) });
  }
  return { packed, findings };
}

/** npm's packument for `name`, refreshed into `cacheDir` and read back from it when offline. */
async function upstreamPackument(name: string, cacheDir: string): Promise<unknown> {
  const cached = Bun.file(join(cacheDir, `${encodeURIComponent(name)}.json`));
  try {
    const response = await fetch(`${UPSTREAM}/${name.replace('/', '%2f')}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const text = await response.text();
      await Bun.write(cached, text);
      return JSON.parse(text);
    }
    if (response.status === 404) return undefined;
  } catch {
    // Offline: the cached copy below answers, and a package never cached is one npm never served.
  }
  return (await cached.exists()) ? cached.json() : undefined;
}

export type ScopeMode =
  | { readonly kind: 'as-of'; readonly version: string }
  | { readonly kind: 'head'; readonly packed: readonly PackedPackage[] };

export interface ScopeRegistry {
  /** The value of the scope's `registry=`. A fresh path per server: Bun keys its cache on it. */
  readonly url: string;
  stop(): void;
}

const notFound = (): Response => new Response(null, { status: 404 });

/** One loopback server for one mode; `stop()` it when the fixture is done with it. */
export function serveScope(mode: ScopeMode, cacheDir: string): ScopeRegistry {
  mkdirSync(cacheDir, { recursive: true });
  const prefix = `/${crypto.randomUUID().slice(0, 8)}`;
  const packed = mode.kind === 'head' ? mode.packed : [];
  const byName = new Map(packed.map((one) => [one.name, one]));
  const byFile = new Map(packed.map((one) => [tarballName(one.name, one.version), one]));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(`${prefix}/`)) return notFound();
      const rest = pathname.slice(prefix.length);
      if (rest.startsWith('/-/tarball/')) {
        const one = byFile.get(rest.slice('/-/tarball/'.length));
        return one === undefined ? notFound() : new Response(Bun.file(one.file));
      }
      const name = packageOfPath(rest);
      if (name === undefined) return notFound();
      const upstream = await upstreamPackument(name, cacheDir);
      if (mode.kind === 'as-of') {
        const cut = asOf(upstream, mode.version);
        return cut === undefined ? notFound() : Response.json(cut);
      }
      const head = byName.get(name);
      if (head === undefined) return upstream === undefined ? notFound() : Response.json(upstream);
      const tarball = `${server.url.origin}${prefix}/-/tarball/${tarballName(head.name, head.version)}`;
      return Response.json(withHead(upstream, head, tarball));
    },
  });
  return { url: `${server.url.origin}${prefix}/`, stop: () => void server.stop(true) };
}

/**
 * Removes the scope's loopback-registry entries from a Bun install cache: Bun keys an entry on the
 * registry host, so each HEAD pack lands beside npm's and would only ever be dead weight there.
 */
export function purgeLoopbackEntries(installCache: string): readonly string[] {
  const scopeDir = join(installCache, SCOPE);
  let entries: readonly string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return [];
  }
  const loopback = entries.filter((entry) => entry.includes('@@127.0.0.1__'));
  for (const entry of loopback) rmSync(join(scopeDir, entry), { recursive: true, force: true });
  return loopback;
}
