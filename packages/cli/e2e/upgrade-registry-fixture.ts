// A local npm registry for the `x upgrade` e2e, run as its own process because the test preload seals
// `fetch`: this checkout's `@ultimat3/*`, stamped as one release nobody published, in front of the real
// npm for everything else — so a real old release and the "newest" CLI resolve side by side. Prints
// `{ "url": … }` once it serves. Usage: bun upgrade-registry-fixture.ts <repo root> <from> <to> <work dir>

// why: Bun has no recursive copy or directory listing primitive.
import { cpSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
// why: Bun exposes no path-join primitive or basename.
import { basename, join } from 'node:path';

const UPSTREAM = 'https://registry.npmjs.org';
const SKIP_COPY = new Set(['node_modules', 'dist', 'coverage']);

interface Stamped {
  readonly manifest: Record<string, unknown>;
  readonly tarball: string;
  readonly integrity: string;
}

const stamp = (text: string, to: string): string =>
  text
    .replace(/("version"\s*:\s*")[^"]*(")/, `$1${to}$2`)
    .replace(/("@ultimat3\/[a-z0-9-]+"\s*:\s*")[^"]*(")/g, `$1${to}$2`);

/**
 * What a workspace's `prepack` does in the checkout, done to the copy: a copy outside the checkout
 * has no `../../scripts`, so its pack runs with `--ignore-scripts` and the hook's one effect — the
 * CLI's `wiki/` (`scripts/pack-cli-wiki.ts`) — is the real function, run over a root whose `wiki`
 * is the checkout's and whose `packages/cli` is the copy.
 */
function prepack(root: string, copyRoot: string, scripts: unknown): void {
  const hook = (scripts as { readonly prepack?: unknown } | undefined)?.prepack;
  if (typeof hook !== 'string' || !hook.includes('pack-cli-wiki')) return;
  symlinkSync(join(root, 'wiki'), join(copyRoot, 'wiki'));
  const script = `const { packWiki } = await import(${JSON.stringify(join(root, 'scripts', 'pack-cli-wiki.ts'))}); const { finding } = packWiki(${JSON.stringify(copyRoot)}); if (finding) { console.error(finding.cause); process.exit(1); }`;
  const ran = Bun.spawnSync([process.execPath, '-e', script], {
    stderr: 'inherit',
    timeout: 60_000,
  });
  if (ran.exitCode !== 0) process.exit(1);
}

/**
 * The tarball `bun pm pack` left behind, or the end of the fixture: a pack that failed says which
 * package and why.
 *
 * The path is read off the command's last line of stdout, so a pack that died leaves no path at
 * all — and reading `Bun.file('')` then dies on an empty path, naming neither the package nor the
 * command. A box under load kills that subprocess (a signal leaves no exit code), so one retry
 * follows: the pack is deterministic, and a second failure is the answer, not a flake to hide.
 */
function packTarball(copy: string, out: string, name: string): string {
  const command = [
    process.execPath,
    'pm',
    'pack',
    '--destination',
    out,
    '--quiet',
    '--ignore-scripts',
  ];
  let proc = Bun.spawnSync(command, { cwd: copy, timeout: 60_000 });
  let tarball = proc.stdout.toString().trim().split('\n').at(-1) ?? '';
  if (proc.exitCode !== 0 || tarball === '') {
    proc = Bun.spawnSync(command, { cwd: copy, timeout: 60_000 });
    tarball = proc.stdout.toString().trim().split('\n').at(-1) ?? '';
  }
  if (proc.exitCode !== 0 || tarball === '') {
    process.stderr.write(
      `pack failed for ${name}: bun pm pack exited ${String(proc.exitCode)} in ${copy}\n${proc.stderr.toString()}\n`,
    );
    process.exit(1);
  }
  return tarball;
}

/** One workspace as `bun pm pack` ships it, under the stamped version. */
async function pack(
  root: string,
  source: string,
  work: string,
  to: string,
): Promise<Stamped | undefined> {
  const text = await Bun.file(join(source, 'package.json')).text();
  const { name, scripts } = JSON.parse(text) as {
    readonly name: string;
    readonly scripts?: unknown;
  };
  if (!name.startsWith('@ultimat3/')) return undefined;
  // `<copy root>/packages/<dir>`, the checkout's own shape, so a hook's `packages/cli` is the copy.
  const copyRoot = join(work, 'copies', name.replace('/', '__'));
  const copy = join(copyRoot, 'packages', basename(source));
  cpSync(source, copy, {
    recursive: true,
    filter: (path) => !SKIP_COPY.has(path.split('/').at(-1) ?? ''),
  });
  await Bun.write(join(copy, 'package.json'), stamp(text, to));
  const out = join(work, 'tarballs');
  mkdirSync(out, { recursive: true });
  prepack(root, copyRoot, scripts);
  const tarball = packTarball(copy, out, name);
  const bytes = await Bun.file(tarball).bytes();
  const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`;
  return {
    manifest: JSON.parse(await Bun.file(join(copy, 'package.json')).text()),
    tarball,
    integrity,
  };
}

const [root = '', from = '', to = '', work = ''] = Bun.argv.slice(2);
const packagesDir = join(root, 'packages');
const stamped = new Map<string, Stamped>();
await Promise.all(
  readdirSync(packagesDir).map(async (dir) => {
    const made = await pack(root, join(packagesDir, dir), work, to);
    const name = made?.manifest['name'];
    if (made !== undefined && typeof name === 'string') stamped.set(name, made);
  }),
);

/** npm's document for the name, narrowed to the one real release and the one stamped. */
async function packument(name: string, origin: string, held: Stamped): Promise<Response> {
  const upstream = await fetch(`${UPSTREAM}/${name.replace('/', '%2f')}`);
  const doc = (await upstream.json()) as { versions?: Record<string, unknown> };
  const real = doc.versions?.[from];
  const body = {
    name,
    'dist-tags': { latest: to },
    versions: {
      ...(real === undefined ? {} : { [from]: real }),
      [to]: {
        ...held.manifest,
        dist: {
          tarball: `${origin}/-/tarball/${encodeURIComponent(name)}`,
          integrity: held.integrity,
        },
      },
    },
  };
  return Response.json(body);
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/-/tarball/')) {
      const name = decodeURIComponent(url.pathname.slice('/-/tarball/'.length));
      const held = stamped.get(name);
      return held === undefined
        ? new Response('not found', { status: 404 })
        : new Response(Bun.file(held.tarball));
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const held = stamped.get(name);
    if (held !== undefined) return packument(name, url.origin, held);
    // A fresh response: `fetch` already decompressed the body, and its `content-encoding` came along.
    const upstream = await fetch(`${UPSTREAM}${url.pathname}`, {
      headers: { accept: request.headers.get('accept') ?? 'application/json' },
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  },
});

console.log(JSON.stringify({ url: server.url.origin, packages: stamped.size }));
