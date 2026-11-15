// The `@ultimat3` scope on loopback, for a fixture's `.npmrc`: npm's packuments cut back to a past
// release (`asOf`), or npm's plus the working tree packed as one more release (`withHead`). So
// `x upgrade --to <HEAD>` resolves, installs and gates exactly as it will the day HEAD is on npm,
// and every dependency outside the scope still comes from npm itself.

// why: Bun has no directory listing, mkdir or recursive remove; the pack dir and cache are managed here.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { dirname, join } from 'node:path';
import type { Finding } from './lib/log';
import { LONG_RUN_TIMEOUT_MS, run } from './lib/run';
import type { PackedPackage } from './upgrade-fixtures-packument';
import {
  asOf,
  packageOfPath,
  retargetManifest,
  SCOPE,
  tarballName,
  withHead,
} from './upgrade-fixtures-packument';

export const UPSTREAM = 'https://registry.npmjs.org';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const integrityOf = async (file: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(await Bun.file(file).arrayBuffer());
  return `sha512-${hasher.digest('base64')}`;
};

/**
 * A packed tarball restamped as release `to`: unpacked, its `package.json` rewritten
 * (`retargetManifest`), packed again under the name `bun pm pack` would give that release. The
 * system `tar`, which every runner ships: Bun has no archive API.
 */
async function restamp(
  file: string,
  manifest: Readonly<Record<string, unknown>>,
  from: string,
  to: string,
  name: string,
): Promise<{ readonly file: string; readonly manifest: Record<string, unknown> } | string> {
  const work = `${file}.d`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const untar = await run(['tar', '-xzf', file, '-C', work], { cwd: work });
  if (!untar.ok) return untar.output;
  const restamped = retargetManifest(manifest, from, to);
  await Bun.write(join(work, 'package', 'package.json'), `${JSON.stringify(restamped, null, 2)}\n`);
  const out = join(dirname(file), tarballName(name, to));
  const tar = await run(['tar', '-czf', out, '-C', work, 'package'], { cwd: work });
  rmSync(work, { recursive: true, force: true });
  if (!tar.ok) return tar.output;
  rmSync(file, { force: true });
  return { file: out, manifest: restamped };
}

/**
 * Every publishable `@ultimat3/*` workspace under `root/packages`, packed into `dest` and served as
 * release `target` (the next minor, `nextMinor`) — the packs restamped when it differs.
 */
export async function packHead(
  root: string,
  dest: string,
  target: string,
): Promise<{ readonly packed: readonly PackedPackage[]; readonly findings: readonly Finding[] }> {
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
    // The tarball's own manifest, not the workspace's: `bun pm pack` rewrites `workspace:` ranges.
    const packedManifest = await run(['tar', '-xzOf', file, 'package/package.json'], {
      cwd: dest,
    });
    const shipped: unknown = packedManifest.ok ? JSON.parse(packedManifest.output) : manifest;
    const base = isRecord(shipped) ? shipped : manifest;
    const stamped =
      target === version
        ? { file, manifest: base }
        : await restamp(file, base, version, target, name);
    if (typeof stamped === 'string') {
      findings.push({
        code: 'X_UPGRADE_FIXTURE_UNBUILT',
        cause: `${name} could not be restamped as ${target}: ${stamped.slice(-400)}`,
        fix: `tar -tzf ${file}`,
        at: `packages/${dir}/package.json`,
      });
      continue;
    }
    packed.push({
      name,
      version: target,
      manifest: stamped.manifest,
      file: stamped.file,
      integrity: await integrityOf(stamped.file),
    });
  }
  return { packed, findings };
}

/** npm's packument for `name`, refreshed into `cacheDir` and read back from it when offline. */
async function upstreamPackument(name: string, cacheDir: string): Promise<unknown> {
  const cached = Bun.file(join(cacheDir, `${encodeURIComponent(name)}.json`));
  try {
    const response = await fetch(`${UPSTREAM}/${name.replaceAll('/', '%2f')}`, {
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
    async fetch(request: Request): Promise<Response> {
      const { origin, pathname } = new URL(request.url);
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
      const tarball = `${origin}${prefix}/-/tarball/${tarballName(head.name, head.version)}`;
      return Response.json(withHead(upstream, head, tarball));
    },
  });
  return { url: `${server.url.origin}${prefix}/`, stop: () => void server.stop(true) };
}
