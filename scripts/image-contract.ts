#!/usr/bin/env bun
// Enforce, as a gate step, the two properties that make `docker/Dockerfile` produce an image that
// can start. It shipped one that could not: the build stage was `oven/bun:1.3-alpine`, so the
// compiled binary asked for `/lib/ld-musl-x86_64.so.1` on a glibc-only distroless runtime and EVERY
// container of EVERY build died with `exec /app/x: no such file or directory`. The build stayed
// green, because the one thing that would have caught it — `/out/app --version` — ran on the BUILD
// stage, which is not what ships. `docker build` runs on no PR, so nothing stops either recurring.
//
// THREE RULES, all derived entirely from files, none needing a table that can go stale:
//   libc     the stage the runtime COPYs its artifact from must link the same libc family the
//            runtime provides. `alpine` means musl and `slim`/`debian`/`distroless/cc` mean glibc
//            for as long as those distributions exist; an image neither pattern recognises yields
//            NO finding, because unknown is not broken.
//   guard    the final stage's ENTRYPOINT binary must be RUN inside that same stage. "There is a
//            guard" and "the guard runs on what ships" are different claims and only the second was
//            violated — the broken Dockerfile had a guard, one stage too early.
//   secret   every `*.dockerignore` in the tree must exclude the secrets master key. All four
//            excluded `.env` and `.npmrc` and none excluded `.secrets.key`, so `COPY . .` baked the
//            AES key into a layer beside the committed `secrets.enc.json` it decrypts — and
//            `findMasterKey` reads the file whenever `ULTIMATE_SECRETS_KEY` is unset, so the
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

import { SECRETS_KEY_FILE } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const DOCKERFILE = 'docker/Dockerfile';

export interface Instruction {
  readonly keyword: string;
  readonly value: string;
  /** 1-based, so `docker/Dockerfile:92` opens it. */
  readonly line: number;
}

export interface Stage {
  readonly base: string;
  readonly name?: string;
  readonly line: number;
  readonly instructions: readonly Instruction[];
}

/**
 * Stages, with continuations joined and comments dropped. A `RUN` that spans five lines is one
 * instruction — reading the file line by line would see its tail as five unknown keywords.
 */
export function parseDockerfile(text: string): readonly Stage[] {
  const stages: Stage[] = [];
  const lines = text.split('\n');
  let buffer = '';
  let start = 0;
  for (const [index, raw] of lines.entries()) {
    const line = raw ?? '';
    if (buffer === '' && /^\s*(?:#|$)/.test(line)) continue;
    if (buffer === '') start = index + 1;
    buffer += line.replace(/\\\s*$/, ' ');
    if (/\\\s*$/.test(line)) continue;
    const match = /^\s*([A-Za-z]+)\s+(.*)$/.exec(buffer);
    buffer = '';
    if (match === null) continue;
    const keyword = (match[1] ?? '').toUpperCase();
    const value = (match[2] ?? '').trim();
    if (keyword === 'FROM') {
      // `FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build` — the flags come FIRST, and
      // reading `--platform=…` as the base image made `libcOf` answer `undefined`, which this file
      // treats as "unknown, say nothing". A cross-build Dockerfile would therefore have skipped the
      // libc rule entirely: the one syntax most likely to pair two architectures, silently exempt.
      const from = /^((?:--\S+\s+)*)(\S+)(?:\s+[Aa][Ss]\s+(\S+))?/.exec(value);
      stages.push({
        base: from?.[2] ?? value,
        line: start,
        instructions: [],
        ...(from?.[3] === undefined ? {} : { name: from[3] }),
      });
      continue;
    }
    const stage = stages.at(-1);
    if (stage === undefined) continue;
    (stage.instructions as Instruction[]).push({ keyword, value, line: start });
  }
  return stages;
}

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

/** `COPY --from=build /out/app /app/x` -> `build`. */
export const copySources = (stage: Stage): readonly string[] =>
  stage.instructions
    .filter((one) => one.keyword === 'COPY')
    .flatMap((one) => [...one.value.matchAll(/--from=(\S+)/g)].map((match) => match[1] ?? ''));

/** A stage may build `FROM` another stage; follow it to the image that actually supplies the libc. */
export function baseImageOf(stage: Stage, stages: readonly Stage[]): string {
  let current = stage;
  for (let hop = 0; hop < stages.length; hop += 1) {
    const next = stages.find((one) => one.name?.toLowerCase() === current.base.toLowerCase());
    if (next === undefined) return current.base;
    current = next;
  }
  return current.base;
}

export type ImageGapKind = 'libc' | 'guard';

export interface ImageGap {
  readonly kind: ImageGapKind;
  readonly line: number;
  /** For `libc`: the producing stage's image and family. For `guard`: the entrypoint binary. */
  readonly detail: string;
  readonly runtime: string;
}

/** Pure, so the negative case is a fixture rather than an edit to the Dockerfile that ships. */
export function checkImage(dockerfile: string): readonly ImageGap[] {
  const stages = parseDockerfile(dockerfile);
  const runtime = stages.at(-1);
  if (runtime === undefined) return [];
  const runtimeImage = baseImageOf(runtime, stages);
  const runtimeLibc = libcOf(runtimeImage);
  const gaps: ImageGap[] = [];

  for (const source of copySources(runtime)) {
    const producer = stages.find((one) => one.name?.toLowerCase() === source.toLowerCase());
    if (producer === undefined) continue;
    const image = baseImageOf(producer, stages);
    const libc = libcOf(image);
    if (libc === undefined || runtimeLibc === undefined || libc === runtimeLibc) continue;
    gaps.push({
      kind: 'libc',
      line: producer.line,
      detail: `${source} on ${image} (${libc})`,
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
        line: entrypoint?.line ?? runtime.line,
        detail: binary,
        runtime: runtimeImage,
      });
    }
  }
  return gaps;
}

const where = (gap: ImageGap): string => `${DOCKERFILE}:${gap.line}`;

const libcFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_LIBC_MISMATCH',
  cause: `${DOCKERFILE} builds its artifact in stage ${gap.detail} and ships it on ${gap.runtime}, so the binary asks for a loader the runtime does not have — every container exits "exec: no such file or directory" and the build stays green`,
  fix: `change that stage's FROM to a base of the same libc family as the runtime in ${DOCKERFILE}, then docker build -f ${DOCKERFILE} -t ultimate-app:libc-check .`,
  at: where(gap),
});

const guardFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_GUARD_MISSING',
  cause: `the final stage of ${DOCKERFILE} ships ${gap.detail} as its ENTRYPOINT and never runs it, so a binary that cannot exec passes the build and fails on the first command an operator runs — a guard in an earlier stage proves the build image, which is not what ships`,
  fix: `add \`RUN ["${gap.detail}", "--version"]\` to the FINAL stage of ${DOCKERFILE} (exec form — a distroless stage has no shell), then docker build -f ${DOCKERFILE} -t ultimate-app:guard-check .`,
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
 * Every `*.dockerignore` in the tree, contents included. Globbed rather than listed: the four that
 * exist today were each added beside a new Dockerfile, and a table here would leave the fifth
 * unchecked with nothing red — the defect class this whole file exists to close.
 */
export async function ignoreFilesOf(root: string): Promise<readonly IgnoreFile[]> {
  const paths = [...new Bun.Glob('**/*.dockerignore').scanSync({ cwd: root, dot: true })].sort();
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
 * The Dockerfile, or `undefined`. ONE read, shared by the gate check and the command below — they
 * used to read the path separately and disagree about it being gone: `imageGaps` answered `[]` and
 * `main` crashed on a bare ENOENT with no code, no `fix:` and no `--json` payload.
 *
 * ABSENCE IS NOT A FINDING HERE, and that is a per-check decision rather than a house style: unlike
 * `wiki/Realtime.md`, which is the only public description of a protocol this tree still ships, a
 * repo with no Dockerfile is a repo that builds no image, and there is no counterpart artifact left
 * making a claim. The rule says so out loud in its summary instead of answering a silent green.
 */
const readDockerfile = async (root: string): Promise<string | undefined> => {
  const file = Bun.file(`${root}/${DOCKERFILE}`);
  return (await file.exists()) ? await file.text() : undefined;
};

/** Read the Dockerfile, then check it. The one impure step. */
export async function imageGaps(root: string): Promise<readonly ImageGap[]> {
  const text = await readDockerfile(root);
  return text === undefined ? [] : checkImage(text);
}

/** What this repo contributes to `x verify`'s `boundaries` step. */
export const imageContractFindings = async (root: string): Promise<readonly Finding[]> => [
  ...(await imageGaps(root)).map(imageGapFindingFor),
  ...checkIgnores(await ignoreFilesOf(root)).map(ignoreGapFindingFor),
];

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const text = await readDockerfile(root);
  const gaps = text === undefined ? [] : checkImage(text);
  const stages = text === undefined ? [] : parseDockerfile(text);
  const ignores = await ignoreFilesOf(root);
  const ignoreGaps = checkIgnores(ignores);
  const findings = [...gaps.map(imageGapFindingFor), ...ignoreGaps.map(ignoreGapFindingFor)];
  const green =
    text === undefined
      ? `no ${DOCKERFILE} in this tree, so it builds no image and there is nothing to check`
      : `${stages.length} stages in ${DOCKERFILE}: one libc family, and the shipped entrypoint proven in the stage that ships it; ${ignores.length} ignore file(s) keep ${SECRETS_KEY_FILE} out of every build context`;
  report(
    {
      ok: findings.length === 0,
      script: 'image-contract',
      summary: findings.length === 0 ? green : `${findings.length} image-contract violation(s)`,
      findings,
      data: {
        dockerfile: text === undefined ? null : DOCKERFILE,
        stages: stages.length,
        ignoreFiles: ignores.map((one) => one.file),
      },
    },
    args.json,
  );
}
