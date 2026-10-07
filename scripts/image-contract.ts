#!/usr/bin/env bun
// Enforce, as a gate step, the two properties that make `docker/Dockerfile` produce an image that
// can start. It shipped one that could not: the build stage was `oven/bun:1.3-alpine`, so the
// compiled binary asked for `/lib/ld-musl-x86_64.so.1` on a glibc-only distroless runtime and EVERY
// container of EVERY build died with `exec /app/x: no such file or directory`. The build stayed
// green, because the one thing that would have caught it — `/out/app --version` — ran on the BUILD
// stage, which is not what ships. `docker build` runs on no PR, so nothing stops either recurring.
//
// THREE RULES over EVERY Dockerfile in the tree, derived from files, none needing a stale table:
//   libc     whatever the runtime COPYs its artifact from — a stage by name or index, or an
//            external image, and RECURSIVELY whatever that stage copied in (alpine build ->
//            debian assemble -> distroless still ships a musl binary) — must link the libc family
//            the runtime provides. `alpine` means
//            musl and `slim`/`debian`/`distroless/cc` mean glibc for as long as those
//            distributions exist; an image neither pattern recognises yields NO finding, because
//            unknown is not broken.
//   guard    the final stage's ENTRYPOINT binary must be RUN inside that same stage. "There is a
//            guard" and "the guard runs on what ships" are different claims and only the second was
//            violated — the broken Dockerfile had a guard, one stage too early.
//   secret   every Dockerfile has an ignore file, and every `*.dockerignore` excludes the master
//            key. All four excluded `.env` and `.npmrc` and none `.secrets.key`, so `COPY . .`
//            baked the AES key into a layer beside the committed `secrets.enc.json` it decrypts
//            — and `findMasterKey` reads the file whenever `ULTIMATE_SECRETS_KEY` is unset, so the
//            container boots on the baked key and the env path is never exercised.
//            `wiki/CLI-Reference.md` stated the invariant ("ships no key file at all") and nothing
//            enforced it. A generated app's ignore file is written by
//            `packages/cli/src/templates/scaffold-container.ts`, which no root here can read, so
//            that copy is held to the same line by `scaffold-container.test.ts`.
//
// What is deliberately NOT here: the Dockerfile's own claim that the runtime's Debian GENERATION
// must equal the build base's. It is true (glibc is backward but not forward compatible), and
// checking it needs a tag -> glibc-version table — `oven/bun:1.3-slim` is trixie and says so
// nowhere in its tag. That table is a hand-kept list that fails on a CORRECT Dockerfile the day
// oven/bun rebases, which is the defect class this whole file exists to close.
//
//   bun run scripts/image-contract.ts [--json]

import { renderFixShellArg, renderThrowable, SECRETS_KEY_FILE } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import { baseImageOf, copySources, parseDockerfile, producersOf } from './lib/dockerfile-stages';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

export const DOCKERFILE = 'docker/Dockerfile';

export type { Instruction, Producer, Stage } from './lib/dockerfile-stages';
export { baseImageOf, copySources, parseDockerfile, producersOf };

export type Libc = 'musl' | 'glibc';

/**
 * Which C library an image provides. Facts about distributions, not version pins: Alpine will not
 * stop being musl and Debian will not stop being glibc, so this table cannot rot the way a
 * tag -> glibc-version table would. Anything unrecognised answers `undefined`, and an unknown side
 * produces no finding — a checker that guessed here would fail on a correct Dockerfile.
 */
export function libcOf(image: string): Libc | undefined {
  if (/(?:^|[-:/@._])(?:alpine|musl)/i.test(image)) return 'musl';
  if (/distroless\/(?:cc|base)/i.test(image)) return 'glibc';
  if (/(?:^|[-:/@._])(?:slim|debian\d*|bookworm|trixie|bullseye|ubuntu|jammy|noble)/i.test(image)) {
    return 'glibc';
  }
  return undefined;
}

/** `RUN ["a","b"]` and `RUN a b` both answer `a`. Exec form is JSON, shell form is whitespace. */
export function argv0(value: string): string | undefined {
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const head = Array.isArray(parsed) ? parsed[0] : undefined;
      return typeof head === 'string' ? head : undefined;
    } catch {
      // A malformed exec array is docker's error to report, not this rule's to guess at.
      return undefined;
    }
  }
  return text.split(/\s+/)[0];
}

export type ImageGapKind = 'libc' | 'guard';

export interface ImageGap {
  readonly kind: ImageGapKind;
  /** The Dockerfile, repo-relative — every one in the tree is checked, not `DOCKERFILE` alone. */
  readonly file: string;
  readonly line: number;
  /** For `libc`: the producing stage's image and family. For `guard`: the entrypoint binary. */
  readonly detail: string;
  readonly runtime: string;
}

/** Pure, so the negative case is a fixture rather than an edit to the Dockerfile that ships. */
export function checkImage(dockerfile: string, file: string = DOCKERFILE): readonly ImageGap[] {
  const stages = parseDockerfile(dockerfile);
  const runtime = stages.at(-1);
  if (runtime === undefined) return [];
  const runtimeImage = baseImageOf(runtime, stages);
  const runtimeLibc = libcOf(runtimeImage);
  const gaps: ImageGap[] = [];

  for (const producer of producersOf(runtime, stages)) {
    const { source } = producer;
    const libc = libcOf(producer.image);
    if (libc === undefined || runtimeLibc === undefined || libc === runtimeLibc) continue;
    gaps.push({
      kind: 'libc',
      file,
      // An external image has no line of its own; the stage that copies from it is where to look.
      line: producer.line ?? runtime.line,
      detail: `${source} on ${producer.image} (${libc})`,
      runtime: `${runtimeImage} (${runtimeLibc})`,
    });
  }

  const entrypoint = runtime.instructions.filter((one) => one.keyword === 'ENTRYPOINT').at(-1);
  const binary = entrypoint === undefined ? undefined : argv0(entrypoint.value);
  if (binary !== undefined) {
    const runs = runtime.instructions
      .filter((one) => one.keyword === 'RUN')
      .map((one) => argv0(one.value));
    if (!runs.includes(binary)) {
      gaps.push({
        kind: 'guard',
        file,
        line: entrypoint?.line ?? runtime.line,
        detail: binary,
        runtime: runtimeImage,
      });
    }
  }
  return gaps;
}

const where = (gap: ImageGap): string => `${gap.file}:${gap.line}`;

/** The Dockerfile as a `docker build -f` operand — verbatim when a shell reads it as one word. */
const buildFile = (gap: ImageGap): string => renderFixShellArg(gap.file, DOCKERFILE);

const libcFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_LIBC_MISMATCH',
  cause: `${gap.file} builds its artifact in stage ${gap.detail} and ships it on ${gap.runtime}, so the binary asks for a loader the runtime does not have — every container exits "exec: no such file or directory" and the build stays green`,
  fix: `change that stage's FROM to a base of the same libc family as the runtime, then docker build -f ${buildFile(gap)} -t ultimate-app:libc-check .`,
  at: where(gap),
});

const guardFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_GUARD_MISSING',
  cause: `the final stage of ${gap.file} ships ${gap.detail} as its ENTRYPOINT and never runs it, so a binary that cannot exec passes the build and fails on the first command an operator runs — a guard in an earlier stage proves the build image, which is not what ships`,
  fix: `add \`RUN ["${gap.detail}", "--version"]\` to the FINAL stage (exec form — a distroless stage has no shell), then docker build -f ${buildFile(gap)} -t ultimate-app:guard-check .`,
  at: where(gap),
});

const FINDINGS: Readonly<Record<ImageGapKind, (gap: ImageGap) => Finding>> = {
  libc: libcFinding,
  guard: guardFinding,
};

export const imageGapFindingFor = (gap: ImageGap): Finding => FINDINGS[gap.kind](gap);

// ── the third rule: what may enter a build context ───────────────────────────

/**
 * The one pattern that keeps the master key out of every image, read off the constant
 * `findMasterKey` reads (`packages/core/src/secrets-store.ts`) rather than spelled here — a rename
 * of the key file then reports every ignore file in the tree instead of silently unprotecting them.
 *
 * RECURSIVE, and that is the same measurement the `.env` block in each of these files records: an
 * ignore pattern is anchored at the context root and crosses no directory on its own, so a bare
 * `.secrets.key` misses `apps/web/.secrets.key`.
 */
export const SECRET_IGNORE_PATTERN = `**/${SECRETS_KEY_FILE}`;

/** One `*.dockerignore`, by repo-relative path. */
export interface IgnoreFile {
  readonly file: string;
  readonly text: string;
}

/** An ignore file that would let `COPY . .` bake the master key into a layer. */
export interface IgnoreGap {
  readonly file: string;
}

/**
 * Where the key can sit in a build context: at the root, and under any directory a `COPY . .`
 * carries. Two paths rather than one, because a re-include is spelled against a path — `!*.key`
 * puts the root one back and leaves the nested one ignored, and either is the whole key.
 */
const KEY_PATHS = [SECRETS_KEY_FILE, `apps/web/${SECRETS_KEY_FILE}`] as const;

/**
 * Whether a rule has anything to say about where the key sits. A leading `/` or `./` is dropped
 * first: Docker anchors every pattern at the context root either way, so `!/.secrets.key` is the
 * same re-include as `!.secrets.key` and only one of the two spellings matches a relative path.
 */
const matchesKey = (pattern: string): boolean => {
  const anchored = pattern.replace(/^\.?\//, '');
  const glob = new Bun.Glob(anchored);
  return KEY_PATHS.some((path) => glob.match(path));
};

/**
 * Pure, and ORDERED — Docker reads its ignore rules top to bottom and the LAST one that matches a
 * path decides, so the recursive pattern below followed by the same pattern behind a `!` is a
 * context with the key in it. A check spelled "does the line exist" passed that file, which is the
 * shape of every bug this script is about: a rule that is present and a rule that is in force are
 * different questions.
 *
 * The exclusion is still the exact line — that is what the `fix:` below tells an author to write,
 * and a hand-rolled equivalent nobody can grep for is the drift this file exists against — while
 * a re-include counts however it is spelled, because `!**` undoes the rule just as completely.
 */
export const ignoresMasterKey = (text: string): boolean => {
  let ignored = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === SECRET_IGNORE_PATTERN) ignored = true;
    else if (line.startsWith('!') && matchesKey(line.slice(1).trim())) ignored = false;
  }
  return ignored;
};

export const checkIgnores = (files: readonly IgnoreFile[]): readonly IgnoreGap[] =>
  files.filter((one) => !ignoresMasterKey(one.text)).map((one) => ({ file: one.file }));

/**
 * Directories whose contents are generated or installed, never written by an author: a Dockerfile
 * or an ignore file under one is a copy of a tracked file, or a package's own, and not this tree's.
 */
export const SKIPPED_DIRS: readonly string[] = ['node_modules', 'dist', '.git', '.x'];

const SKIPPED = new RegExp(
  `(?:^|/)(?:${SKIPPED_DIRS.map((dir) => dir.replace('.', '\\.')).join('|')})/`,
);

/**
 * Every path `pattern` matches under `root`, outside `SKIPPED_DIRS`. A directory another process
 * deletes mid-walk — a test fixture under the gate's parallel run — makes the glob throw ENOENT on
 * its `readdir`; that is the tree moving, not an answer, so the walk is taken again, three times.
 * A walk that still cannot read the tree is refused with a code: "unread" is never "clean".
 */
function scanTree(root: string, pattern: string, attempts = 3): readonly string[] {
  try {
    return [...new Bun.Glob(pattern).scanSync({ cwd: root, dot: true })]
      .map((path) => path.split('\\').join('/'))
      .filter((path) => !SKIPPED.test(path))
      .sort();
  } catch (error) {
    const vanished = (error as { readonly code?: unknown } | null)?.code === 'ENOENT';
    if (vanished && attempts > 1) return scanTree(root, pattern, attempts - 1);
    throw new ScriptError({
      code: 'X_CORPUS_UNSCANNED',
      cause: `image-contract could not walk ${pattern} under ${root} (${renderThrowable(error)}) — the tree changed or became unreadable during the scan, and a Dockerfile it never read is not one it checked`,
      fix: 'bun run scripts/image-contract.ts --json',
    });
  }
}

/**
 * Every `*.dockerignore` in the tree, contents included. Globbed rather than listed: the four that
 * exist today were each added beside a new Dockerfile, and a table here would leave the fifth
 * unchecked with nothing red — the defect class this whole file exists to close.
 */
export async function ignoreFilesOf(root: string): Promise<readonly IgnoreFile[]> {
  const paths = scanTree(root, '**/*.dockerignore');
  return Promise.all(
    paths.map(async (file) => ({ file, text: await Bun.file(`${root}/${file}`).text() })),
  );
}

export const ignoreGapFindingFor = (gap: IgnoreGap): Finding => ({
  code: 'X_IMAGE_SECRET_UNIGNORED',
  cause: `${gap.file} excludes .env and .npmrc but not ${SECRETS_KEY_FILE}, so a build stage's \`COPY . .\` bakes the AES master key into a layer beside the committed secrets.enc.json it decrypts — and \`findMasterKey\` reads the file whenever ULTIMATE_SECRETS_KEY is unset, so the container boots on the baked key and the platform's own key is never exercised`,
  fix: `add \`${SECRET_IGNORE_PATTERN}\` beside the .npmrc line in ${gap.file}, then bun run scripts/image-contract.ts --json`,
  at: gap.file,
});

/**
 * Every Dockerfile in the tree, by the three names docker and the repo's convention use. It read
 * `docker/Dockerfile` alone, so the image `deploy-social-demo.yml` ships —
 * `dummy/social-media-clone/docker/Dockerfile.monorepo` — was held to none of these rules.
 */
export async function dockerfilesOf(root: string): Promise<readonly string[]> {
  const found = ['**/Dockerfile', '**/Dockerfile.*', '**/*.Dockerfile'].flatMap((pattern) =>
    scanTree(root, pattern),
  );
  return [...new Set(found)].filter((path) => !path.endsWith('.dockerignore')).sort();
}

/**
 * The ignore files docker would read for `file`: the per-Dockerfile `<file>.dockerignore`, or a
 * `.dockerignore` at the root of a context — any directory from the Dockerfile's own up to the
 * repo root, the contexts a build of it can plausibly name.
 */
export const ignoreCandidates = (file: string): readonly string[] => {
  const dirs = file.split('/').slice(0, -1);
  const roots = dirs.map((_, depth) => `${dirs.slice(0, dirs.length - depth).join('/')}/`);
  return [`${file}.dockerignore`, ...roots.map((dir) => `${dir}.dockerignore`), '.dockerignore'];
};

/**
 * A Dockerfile with NO ignore file passed the master-key rule by giving it nothing to read: the
 * third rule checks what each ignore file says, and an absent one says nothing.
 */
const unignoredFinding = (file: string): Finding => ({
  code: 'X_IMAGE_SECRET_UNIGNORED',
  cause: `${file} has no ignore file — no ${file}.dockerignore beside it and no .dockerignore at or above it — so a build stage's \`COPY . .\` carries ${SECRETS_KEY_FILE}, .env and .npmrc into a layer`,
  fix: `printf '%s\\n' '**/.env' '**/.npmrc' '${SECRET_IGNORE_PATTERN}' > ${renderFixShellArg(`${file}.dockerignore`, 'Dockerfile.dockerignore')} && bun run scripts/image-contract.ts --json`,
  at: file,
});

/**
 * Every Dockerfile and what it ships, read once — shared by the gate check and the command below.
 *
 * ABSENCE IS NOT A FINDING HERE, and that is a per-check decision rather than a house style: a repo
 * with no Dockerfile is a repo that builds no image, and there is no counterpart artifact left
 * making a claim. The rule says so out loud in its summary instead of answering a silent green.
 */
async function readDockerfiles(
  root: string,
): Promise<readonly { readonly file: string; readonly text: string }[]> {
  const files = await dockerfilesOf(root);
  return Promise.all(
    files.map(async (file) => ({ file, text: await Bun.file(`${root}/${file}`).text() })),
  );
}

/** Read every Dockerfile, then check each. */
export async function imageGaps(root: string): Promise<readonly ImageGap[]> {
  return (await readDockerfiles(root)).flatMap((one) => checkImage(one.text, one.file));
}

/** All three rules over one read of the tree. */
async function imageContract(root: string) {
  const dockerfiles = await readDockerfiles(root);
  const ignores = await ignoreFilesOf(root);
  const present = new Set(ignores.map((one) => one.file));
  const findings: readonly Finding[] = [
    ...dockerfiles.flatMap((one) => checkImage(one.text, one.file)).map(imageGapFindingFor),
    ...dockerfiles
      .filter((one) => !ignoreCandidates(one.file).some((path) => present.has(path)))
      .map((one) => unignoredFinding(one.file)),
    ...checkIgnores(ignores).map(ignoreGapFindingFor),
  ];
  return { dockerfiles, ignores, findings };
}

/** What this repo contributes to `x verify`'s `boundaries` step. */
export const imageContractFindings = async (root: string): Promise<readonly Finding[]> =>
  (await imageContract(root)).findings;

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { dockerfiles, ignores, findings } = await imageContract(repoRoot());
  const green =
    dockerfiles.length === 0
      ? 'no Dockerfile in this tree, so it builds no image and there is nothing to check'
      : `${dockerfiles.length} Dockerfile(s): each ships one libc family and proves its entrypoint in the stage that ships it; ${ignores.length} ignore file(s) keep ${SECRETS_KEY_FILE} out of every build context`;
  report(
    {
      ok: findings.length === 0,
      script: 'image-contract',
      summary: findings.length === 0 ? green : `${findings.length} image-contract violation(s)`,
      findings,
      data: {
        dockerfiles: dockerfiles.map((one) => ({
          file: one.file,
          stages: parseDockerfile(one.text).length,
        })),
        ignoreFiles: ignores.map((one) => one.file),
      },
    },
    args.json,
  );
}
