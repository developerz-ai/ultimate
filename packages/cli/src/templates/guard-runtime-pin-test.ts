// The test `x new` writes beside the `runtime-pin` guard: the rule's own cases, run in the app.
// Split from `guard-runtime-pin.ts` at the file target; the code and the image are handed in.

import { SCAFFOLD_BUN_IMAGE } from './bun-image';

export const runtimePinTest = (code: string): string => {
  const { patch, ref, series, variant } = SCAFFOLD_BUN_IMAGE;
  return `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { runtimePins } from './runtime-pin';

/** The image \`x new\` wrote: the digest every FROM builds on. */
const IMAGE =
  '${ref}';

const ENGINES = { path: 'package.json', source: '{ "engines": { "bun": ">=${patch}" } }' };
const workflow = (pin: string) => ({
  path: '.github/workflows/ci.yml',
  source: ['jobs:', '  a:', '    steps:', \`          bun-version: \${pin}\`].join('\\n'),
});
const dockerfile = (from: string) => ({
  path: 'docker/Dockerfile',
  source: \`FROM \${from} AS deps\`,
});

unitTest('a CI pin off engines.bun is refused at its line, with the line to write', () => {
  const findings = runtimePins([ENGINES, workflow("'1.0.0'")]);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${code}');
  expect(findings[0]?.at).toBe('.github/workflows/ci.yml:4');
  expect(findings[0]?.fix).toStartWith("edit .github/workflows/ci.yml:4 — bun-version: '${patch}'");
});

unitTest('an image tag with no digest is refused, and the fix pastes one', () => {
  const findings = runtimePins([ENGINES, dockerfile('oven/bun:${series}-${variant}')]);
  expect(findings.map((finding) => finding.at)).toEqual(['docker/Dockerfile:1']);
  expect(findings[0]?.fix).toContain(\`FROM \${IMAGE} AS deps\`);
});

unitTest('no engines.bun is refused: nothing else can be checked against it', () => {
  const findings = runtimePins([{ path: 'package.json', source: '{}' }]);
  expect(findings.map((finding) => finding.at)).toEqual(['package.json:1']);
});

unitTest('the same patch, its series, an expression and a digest-pinned image are silent', () => {
  expect(runtimePins([ENGINES, workflow("'${patch}'"), dockerfile(IMAGE)])).toEqual([]);
  expect(runtimePins([ENGINES, workflow('${series}.x')])).toEqual([]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, written as text.
  expect(runtimePins([ENGINES, workflow('\${{ matrix.bun }}')])).toEqual([]);
});
`;
};
