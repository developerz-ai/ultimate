// The `runtime-pin` guard `x new` ships: every Bun pin in the app — `packageManager`,
// `.bun-version`, a workflow's `bun-version:`, a Dockerfile's `FROM oven/bun:` and the patch its
// digest note records — names the one version `engines.bun` declares, and every image builds on a
// digest. Four apps each wrote this check for themselves before it shipped.

import { SCAFFOLD_BUN_IMAGE } from './bun-image';
import { guardCode } from './guard';
import { runtimePinTest } from './guard-runtime-pin-test';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'runtime-pin';
const CODE = guardCode(NAME);

const source =
  (): string => `// runtime-pin: every Bun pin in this app names the one version engines.bun declares.
// \`x verify\` runs it on the \`boundaries\` step; \`{ "severity": { "runtime-pin": "off" } }\` in
// \`guards/shipped.json\` turns it off, \`"warning"\` makes it report only.
//
// Why: the dev box, CI and the image each install their own Bun. When the pins disagree, a green
// gate is evidence about a runtime production never runs, and a lockfile one Bun wrote is installed
// \`--frozen-lockfile\` by another. A tag is a pointer its publisher can move: an image builds on a
// digest. Read: \`package.json\` (\`engines.bun\`, THE version, and \`packageManager\`), \`.bun-version\`,
// every \`bun-version:\` under \`.github/\`, every \`FROM oven/bun:\` in a Dockerfile and the "digest is
// \`oven/bun:<patch>\`" note above it. Not read: an expression, a build arg, any other comment.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** The image \`x new\` wrote, so a fix can paste it when \`engines.bun\` is the patch it was read from. */
const SCAFFOLD = {
  patch: '${SCAFFOLD_BUN_IMAGE.patch}',
  variant: '-${SCAFFOLD_BUN_IMAGE.variant}',
  ref: '${SCAFFOLD_BUN_IMAGE.ref}',
};

export interface PinFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const EXACT = /^\\d+\\.\\d+\\.\\d+$/;
const SERIES = /^(\\d+\\.\\d+)(?:\\.x)?$/;
const ENGINES = /"engines"\\s*:\\s*\\{[^}]*?"bun"\\s*:\\s*"([^"]*)"/;
const PACKAGE_MANAGER = /"packageManager"\\s*:\\s*"bun@([^"]*)"/;
const BUN_VERSION = /^\\s*(?:-\\s*)?bun-version:\\s*['"]?([^'"#\\s]+)/;
const FROM = /^\\s*FROM\\s+(?:--\\S+\\s+)*oven\\/bun:([^\\s@]+)(@sha256:[0-9a-f]{64})?(.*)$/i;
const TAG = /^(\\d+\\.\\d+(?:\\.\\d+)?)(-[\\w.-]+)?$/;
const RECORDED = /digest is \`?oven\\/bun:(\\d+\\.\\d+\\.\\d+)(-[\\w.-]+)?/;

/** Whether a pin names the version: the same patch, or the version's own series. */
const agrees = (pin: string, version: string): boolean => {
  if (EXACT.test(pin)) return pin === version;
  const series = SERIES.exec(pin)?.[1];
  return series !== undefined && version.startsWith(\`\${series}.\`);
};

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\\n').length;

/** The FROM line naming the version by digest: the scaffold's own when it is that patch. */
const imageFor = (version: string, variant: string, rest: string): string =>
  version === SCAFFOLD.patch && variant === SCAFFOLD.variant
    ? \`FROM \${SCAFFOLD.ref}\${rest}\`
    : \`FROM oven/bun:\${version.split('.').slice(0, 2).join('.')}\${variant}@<digest>\${rest}, the digest from: docker buildx imagetools inspect oven/bun:\${version}\${variant}\`;

const finding = (at: string, cause: string, write: string): Finding => ({
  code: CODE,
  cause,
  fix: \`edit \${at} — \${write} — then: x verify --only boundaries\`,
  at,
});

/** \`path:line\` ordering, so two machines list the same findings in the same order. */
const byPlace = (a: Finding, b: Finding): number => {
  const [pathA = '', lineA = '0'] = (a.at ?? '').split(/:(?=\\d+$)/);
  const [pathB = '', lineB = '0'] = (b.at ?? '').split(/:(?=\\d+$)/);
  return pathA === pathB ? Number(lineA) - Number(lineB) : pathA < pathB ? -1 : 1;
};

/** One Dockerfile, workflow or action, line by line: what each pin there says against \`version\`. */
function linePins(file: PinFile, version: string, findings: Finding[]): void {
  const disagrees = (at: string, pin: string, write: string): void => {
    if (agrees(pin, version)) return;
    const cause = \`\${at} pins Bun \${pin} and engines.bun in package.json declares \${version}: the dev box, CI and the image run different runtimes, so a green gate is evidence about none of them\`;
    findings.push(finding(at, cause, write));
  };
  file.source.split('\\n').forEach((text, index) => {
    const at = \`\${file.path}:\${index + 1}\`;
    if (text.trimStart().startsWith('#')) {
      const recorded = RECORDED.exec(text);
      if (recorded === null) return;
      const variant = recorded[2] ?? '';
      const write = \`# The digest is \\\`oven/bun:\${version}\${variant}\\\`'s, with every FROM below it on that digest\`;
      disagrees(at, recorded[1] ?? '', write);
      return;
    }
    const key = BUN_VERSION.exec(text);
    if (key !== null) {
      const pin = key[1] ?? '';
      if (!pin.includes('$')) disagrees(at, pin, \`bun-version: '\${version}'\`);
      return;
    }
    const from = FROM.exec(text);
    if (from === null) return;
    const [, tag = '', digest, rest = ''] = from;
    if (tag.includes('$')) return;
    const parts = TAG.exec(tag);
    const write = imageFor(version, parts?.[2] ?? '', rest.trimEnd());
    if (parts === null || !agrees(parts[1] ?? '', version)) {
      disagrees(at, \`oven/bun:\${tag}\`, write);
    } else if (digest === undefined) {
      const cause = \`\${at} builds on the tag oven/bun:\${tag} alone, a pointer its publisher can move: the same commit can build on two runtimes\`;
      findings.push(finding(at, cause, write));
    }
  });
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function runtimePins(files: readonly PinFile[]): readonly Finding[] {
  const manifest = files.find((file) => file.path === 'package.json')?.source ?? '';
  const declared = ENGINES.exec(manifest)?.[1]?.match(/\\d+\\.\\d+(?:\\.\\d+)?/)?.[0];
  if (declared === undefined) {
    const cause =
      'package.json declares no engines.bun, so no Bun pin in this app names a version anything can check';
    return [finding('package.json:1', cause, \`"engines": { "bun": ">=\${SCAFFOLD.patch}" }\`)];
  }
  // \`>=1.4\` admits 1.4.0: a range's version is its lower bound.
  const version = [...declared.split('.'), '0', '0'].slice(0, 3).join('.');
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.path === 'package.json') {
      const manager = PACKAGE_MANAGER.exec(file.source);
      const pin = manager?.[1];
      if (manager !== null && pin !== undefined && !agrees(pin, version)) {
        const at = \`package.json:\${lineAt(file.source, manager.index)}\`;
        const cause = \`\${at} pins Bun \${pin} and engines.bun declares \${version}: the toolchain and the gate run different runtimes\`;
        findings.push(finding(at, cause, \`"packageManager": "bun@\${version}"\`));
      }
    } else if (file.path === '.bun-version') {
      const pin = file.source.trim();
      if (!agrees(pin, version)) {
        const cause = \`.bun-version pins Bun \${pin} and engines.bun in package.json declares \${version}: the dev box runs a Bun CI does not\`;
        findings.push(finding('.bun-version:1', cause, version));
      }
    } else {
      linePins(file, version, findings);
    }
  }
  return findings.sort(byPlace);
}

/** Every file a Bun pin lives in, one glob each: a wildcard never matches a dot directory. */
const PIN_GLOBS = [
  'package.json',
  '.bun-version',
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.github/actions/**/action.yml',
  '.github/actions/**/action.yaml',
  'Dockerfile*',
  '*.Dockerfile',
  'docker/**/Dockerfile*',
  'docker/**/*.Dockerfile',
];

export const guard: Guard = {
  summary: 'every Bun pin names the one version engines.bun declares; every image is by digest',
  async check(_root, sources) {
    // Each glob is the run's ONE walk of it, shared with any other guard that asks.
    const found = await Promise.all(PIN_GLOBS.map((glob) => sources.files(glob)));
    const files = new Map<string, PinFile>();
    for (const file of found.flat()) {
      if (!file.path.endsWith('.dockerignore')) {
        files.set(file.path, { path: file.path, source: file.text });
      }
    }
    return runtimePins([...files.values()]);
  },
};
`;

/** `guards/runtime-pin.ts` and its test. No index, no registry — the directory registers it. */
export const runtimePinGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: runtimePinTest(CODE) },
];
