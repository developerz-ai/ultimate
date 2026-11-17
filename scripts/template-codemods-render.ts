// What `x new` writes, as a hash per file and variant (example slice on and off, each shape): the
// template-codemod rule's second eye, for a scaffold change made OUTSIDE `templates/` (a constant
// a template prints, a helper it calls). The release's version is masked: a bump changes no file.

// why: the LEAF modules, never the `@ultimat3/cli` barrel — the import deprecation-window.ts makes.
import { planNewApp } from '../packages/cli/src/cmd-new';
import { NEW_SHAPES } from '../packages/cli/src/new-shapes';
import { loadVersion } from '../packages/cli/src/version-loader';

export const RENDER_LOCK_FILE = 'scripts/template-codemods.lock.json';

/** One name for every variant, so a hash moves only when the scaffold does. */
const APP = 'lockapp';

const VARIANTS: readonly {
  readonly key: string;
  readonly plan: () => ReturnType<typeof planNewApp>;
}[] = [
  { key: 'example', plan: () => planNewApp({ name: APP, example: true }) },
  { key: 'bare', plan: () => planNewApp({ name: APP, example: false }) },
  ...NEW_SHAPES.map((shape) => ({
    key: shape,
    plan: () => planNewApp({ name: APP, example: true, shape }),
  })),
];

const hash = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);

/**
 * What `x new` writes, every variant, with the version it prints masked: the version the templates
 * read is the CLI's own stamp (`loadVersion()`), so that is the one to mask — never a caller's.
 */
export function renderedFiles(): Readonly<Record<string, string>> {
  const version = loadVersion();
  const out: Record<string, string> = {};
  for (const variant of VARIANTS) {
    for (const file of variant.plan()) {
      const bytes =
        typeof file.contents === 'string' ? file.contents : new TextDecoder().decode(file.contents);
      out[`${variant.key}:${file.path}`] = bytes.replaceAll(version, '0.0.0');
    }
  }
  return out;
}

/** `<variant>:<path>` to the hash of what that variant of `x new` writes there. */
export function renderScaffold(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(renderedFiles())
      .map(([key, text]) => [key, hash(text)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The rendered paths whose hash differs between two locks, a file added or gone included. */
export function renderedChanges(
  base: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): readonly string[] {
  // Only variants the tag already rendered: a shape added since has no app on it to move, so its
  // files owe no codemod (sweep 9 added five shapes, and every one of their files read as changed).
  const variantOf = (key: string): string => key.slice(0, key.indexOf(':'));
  const known = new Set(Object.keys(base).map(variantOf));
  const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
  const paths = [...keys]
    .filter((key) => known.has(variantOf(key)) && base[key] !== now[key])
    .map((key) => key.slice(key.indexOf(':') + 1));
  return [...new Set(paths)].sort();
}

export const renderLockText = (lock: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(lock, null, 2)}\n`;

export interface RenderCheck {
  /** The rendered paths that changed since the tag's lock: each needs its own row. */
  readonly changed: readonly string[];
  /** Every rendered path: a row may name one. */
  readonly paths: readonly string[];
  /** The working lock is not what `x new` renders now. */
  readonly stale: boolean;
  /** Why the change since the tag was not judged: the tag holds no lock yet. */
  readonly notice?: string;
}

/** The tag's lock against `x new` now, and the working lock against both. */
export async function renderCheck(input: {
  readonly root: string;
  readonly tag: string;
  readonly show: (ref: string) => Promise<string | undefined>;
  readonly now?: Readonly<Record<string, string>>;
}): Promise<RenderCheck> {
  const now = input.now ?? renderScaffold();
  const paths = [...new Set(Object.keys(now).map((key) => key.slice(key.indexOf(':') + 1)))].sort();
  const working = Bun.file(`${input.root}/${RENDER_LOCK_FILE}`);
  const stale = !(await working.exists()) || (await working.text()) !== renderLockText(now);
  const based = await input.show(`${input.tag}:${RENDER_LOCK_FILE}`);
  if (based === undefined) {
    return {
      changed: [],
      paths,
      stale,
      notice: `${input.tag} holds no ${RENDER_LOCK_FILE}: what x new renders is judged from the next release`,
    };
  }
  const base = JSON.parse(based) as Record<string, string>;
  return { changed: renderedChanges(base, now), paths, stale };
}
