// A tracked app's install stages are the template's. The defect: both apps copied `apps/` and
// `packages/` ahead of `bun install`, so every source edit busted the install layer.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  dockerfileTemplateFindings,
  installStages,
  spliceTemplate,
  templateDockerfile,
  templateDrift,
} from './dockerfile-template';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// The last case reads every tracked app's Dockerfile off the real tree.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const TEMPLATE = templateDockerfile('demo');
const FILE = 'apps-dir/docker/Dockerfile';

/** The shape both tracked apps had until 2026-11: the workspace sources copied into the install. */
const COPIES_SOURCES = TEMPLATE.replace(
  /COPY --from=manifests \/app \.\/\nCOPY bun\.lock \.\/\n/,
  'COPY package.json bun.lock ./\nCOPY apps ./apps\nCOPY packages ./packages\n',
);

describe('unit · dockerfile-template', () => {
  test('the fixture really is the source-copying shape, so the red case below is meaningful', () => {
    expect(COPIES_SOURCES).not.toBe(TEMPLATE);
    expect(COPIES_SOURCES).toContain('COPY apps ./apps');
  });

  test('the template has a manifests stage and a deps stage that runs the install', () => {
    expect(installStages(TEMPLATE).map((stage) => stage.name)).toEqual(['manifests', 'deps']);
  });

  test('the template against itself is green', () => {
    expect(templateDrift(TEMPLATE, FILE, TEMPLATE)).toBeUndefined();
  });

  test('a deps stage that copies sources is red, at the first copied line', () => {
    const finding = templateDrift(COPIES_SOURCES, FILE, TEMPLATE);
    expect(finding?.code).toBe('X_DOCKERFILE_DEPS_DRIFT');
    expect(finding?.cause).toContain('COPY package.json bun.lock ./');
    expect(finding?.at).toMatch(/^apps-dir\/docker\/Dockerfile:\d+$/);
    expect(finding?.fix).toBe('bun run scripts/dockerfile-template.ts --write');
  });

  test('an instruction ahead of the install is red', () => {
    const ahead = TEMPLATE.replace('COPY bun.lock ./\n', 'COPY bun.lock ./\nCOPY apps ./apps\n');
    expect(templateDrift(ahead, FILE, TEMPLATE)?.cause).toContain('COPY apps ./apps');
  });

  test('a deps stage longer than the template’s is red, though every template line matches', () => {
    const install = 'RUN bun install --frozen-lockfile --production\n';
    const longer = TEMPLATE.replace(install, `${install}COPY packages ./packages\n`);
    expect(templateDrift(longer, FILE, TEMPLATE)?.cause).toContain('COPY packages ./packages');
  });

  test('a Dockerfile with no install at all is red, not exempt', () => {
    const none = 'FROM oven/bun:1.4-alpine AS runtime\nCOPY . .\n';
    expect(templateDrift(none, FILE, TEMPLATE)?.at).toBe(FILE);
  });

  test('comments and the runtime stage are not compared', () => {
    const edited = TEMPLATE.replace(
      '# ---------- deps:',
      '# a comment of the app’s own\n# ---------- deps:',
    ).replace('EXPOSE 3000', 'EXPOSE 3000 9090');
    expect(templateDrift(edited, FILE, TEMPLATE)).toBeUndefined();
  });

  test('--write splices the template over the drifted stages and keeps the rest of the file', () => {
    const app = COPIES_SOURCES.replace('EXPOSE 3000', 'EXPOSE 3000 9090');
    const spliced = spliceTemplate(app, TEMPLATE);
    expect(templateDrift(spliced, FILE, TEMPLATE)).toBeUndefined();
    expect(spliced).toContain('EXPOSE 3000 9090');
    expect(spliced).not.toContain('COPY apps ./apps');
    expect(spliceTemplate(spliced, TEMPLATE)).toBe(spliced);
  });
});

describe('repository · dockerfile-template', () => {
  test('every tracked app installs from the template’s manifests-only stages', async () => {
    expect(await dockerfileTemplateFindings(repoRoot())).toEqual([]);
  });
});
