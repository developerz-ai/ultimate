// The `@ultimat3` scope as a fixture's install sees it, pure: npm's packument cut back to the day a
// release shipped (`asOf`), or npm's packument plus the working tree as one more release
// (`withHead`). No I/O — `upgrade-fixtures-registry.ts` fetches, packs and serves.

export const SCOPE = '@ultimat3';

/** One packed workspace: what its packument entry is made of. */
export interface PackedPackage {
  readonly name: string;
  readonly version: string;
  /** The packed `package.json`, as the tarball holds it. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly file: string;
  /** `sha512-<base64>`, the field Bun checks a downloaded tarball against. */
  readonly integrity: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * npm's packument as it stood the day `ceiling` shipped: every release above it, and every
 * prerelease, removed, and `latest` moved to the newest left. So a scaffold's `^31.4.0` installs
 * 31.4.0 — what its author's lockfile recorded — and never the 31.4.2 that came later. Undefined
 * when nothing is left: a package that did not exist yet.
 */
export const asOf = (upstream: unknown, ceiling: string): Record<string, unknown> | undefined => {
  if (!isRecord(upstream) || !isRecord(upstream['versions'])) return undefined;
  const kept = Object.entries(upstream['versions']).filter(
    ([version]) => RELEASE.test(version) && Bun.semver.order(version, ceiling) <= 0,
  );
  const newest = kept
    .map(([version]) => version)
    .sort(Bun.semver.order)
    .at(-1);
  if (newest === undefined) return undefined;
  const { time: _time, ...rest } = upstream;
  return { ...rest, 'dist-tags': { latest: newest }, versions: Object.fromEntries(kept) };
};

/**
 * A packument with HEAD's version added and tagged `latest`. The upstream answer may be absent (a
 * package npm has never seen), and is otherwise kept whole, so every release a fixture already
 * pins still resolves to npm's own tarball.
 */
export const withHead = (
  upstream: unknown,
  head: PackedPackage,
  tarballUrl: string,
): Record<string, unknown> => {
  const base = isRecord(upstream) ? upstream : { name: head.name };
  const versions = isRecord(base['versions']) ? base['versions'] : {};
  const tags = isRecord(base['dist-tags']) ? base['dist-tags'] : {};
  return {
    ...base,
    name: head.name,
    'dist-tags': { ...tags, latest: head.version },
    versions: {
      ...versions,
      [head.version]: {
        ...head.manifest,
        name: head.name,
        version: head.version,
        dist: { tarball: tarballUrl, integrity: head.integrity },
      },
    },
  };
};

/**
 * The package a request asks for, after the server's own prefix: npm clients send
 * `/@ultimat3%2fcore` or `/@ultimat3/core`. Anything outside the scope is undefined.
 */
export const packageOfPath = (rest: string): string | undefined => {
  let name: string;
  try {
    name = decodeURIComponent(rest.replace(/^\/+/, ''));
  } catch {
    return undefined;
  }
  return /^@ultimat3\/[a-z0-9-]+$/.test(name) ? name : undefined;
};

/** The `.npmrc` line that sends the scope, and only the scope, to `url`. */
export const scopeLine = (url: string): string => `${SCOPE}:registry=${url}\n`;

/** The tarball file name `bun pm pack` writes for a package: `@ultimat3/core@1.0.0` → `ultimat3-core-1.0.0.tgz`. */
export const tarballName = (name: string, version: string): string =>
  `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
