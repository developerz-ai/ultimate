#!/usr/bin/env bun

// Scaffold a framework package from the contract's templates: the same eight files, the same
// package.json shape, a real error class and two tests that would catch a regression.
//
//   bun run scripts/new-package.ts seo --tier 1 --description "Metadata, sitemaps, robots"
//   bun run scripts/new-package.ts seo --only CLAUDE.md      # fill in one missing contract file

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameworkVersion } from '@ultimat3/core';
import { flagString, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { allowedTiersFor, TIERS, tierOf } from './lib/tiers';

/**
 * The grant, copied rather than referenced. npm packs a `files` entry per package directory and
 * silently drops one with no file behind it, so a package that points at the repo root's LICENSE
 * publishes the MIT claim in its manifest and none of the text — which is how all 28 shipped
 * before the gate learned to check.
 */
const license = (): string => readFileSync(join(repoRoot(), 'LICENSE'), 'utf-8');

interface Template {
  readonly path: string;
  readonly contents: string;
}

const upper = (name: string): string => name.toUpperCase().split('-').join('_');
const pascal = (name: string): string =>
  name
    .split('-')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');

export function packageTemplates(name: string, tier: number, description: string): Template[] {
  const Name = pascal(name);
  return [
    {
      path: 'package.json',
      contents: `{
  "name": "@ultimat3/${name}",
  "version": "${frameworkVersion()}",
  "description": "${description}",
  "license": "MIT",
  "type": "module",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/developerz-ai/ultimate.git",
    "directory": "packages/${name}"
  },
  "publishConfig": { "access": "public", "provenance": true },
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "!src/**/*.test.ts", "README.md", "LICENSE"],
  "engines": { "bun": ">=1.3.0" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "bun test"
  },
  "dependencies": {}
}
`,
    },
    {
      path: 'LICENSE',
      contents: license(),
    },
    {
      path: 'tsconfig.json',
      contents: `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
`,
    },
    {
      path: 'README.md',
      contents: `# @ultimat3/${name}

${description}

## What it owns

| Module | Owns |
|---|---|
| \`src/index.ts\` | the explicit public API |
| \`src/errors.ts\` | this package's X_* codes |

## Boundary

Tier ${tier}. May import tiers ${allowedTiersFor(tier)} only — enforced by
\`bun run scripts/boundaries.ts\`.

## Errors

\`X_${upper(name)}_INVALID\`
`,
    },
    {
      path: 'CLAUDE.md',
      contents: `# @ultimat3/${name} — boundary

Tier ${tier}. May import tiers ${allowedTiersFor(tier)}. Never sideways, never upward.

| Rule | Detail |
|---|---|
| Exports | \`src/index.ts\`, explicit, no \`export *\` |
| Errors | \`src/errors.ts\`, subclass \`UltimateError\`, never a bare \`Error\` |
| Files | one responsibility each, < 200 lines, tests beside the source |

Commands: \`bun test\`, \`bunx tsc --noEmit -p tsconfig.json\`.
`,
    },
    {
      path: 'src/errors.ts',
      contents: `// The X_* codes owned by @ultimat3/${name}. Each names the exact change that resolves it.
import { UltimateError } from '@ultimat3/core';

export const ${upper(name)}_ERROR_CODES = ['X_${upper(name)}_INVALID'] as const;

export type ${Name}ErrorCode = (typeof ${upper(name)}_ERROR_CODES)[number];

export class ${Name}InvalidError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({
      code: 'X_${upper(name)}_INVALID',
      cause: input.cause,
      fix: input.fix,
      docs: 'https://ultimate.dev/errors/X_${upper(name)}_INVALID',
    });
  }
}
`,
    },
    {
      path: 'src/index.ts',
      contents: `// Public API of @ultimat3/${name}. Explicit re-exports only.

export { ${upper(name)}_ERROR_CODES, ${Name}InvalidError } from './errors';
export type { ${Name}ErrorCode } from './errors';
`,
    },
    {
      path: 'src/errors.test.ts',
      contents: `import { describe, expect, test } from 'bun:test';
import { ${Name}InvalidError, ${upper(name)}_ERROR_CODES } from './errors';

describe('unit · @ultimat3/${name} errors', () => {
  test('the error carries a stable code, a cause and a fix', () => {
    const error = new ${Name}InvalidError({ cause: 'because', fix: 'x doctor --json' });
    expect(error).toBeUltimateError('X_${upper(name)}_INVALID');
    expect(error.fix).toBe('x doctor --json');
  });

  test('every declared code is namespaced and screaming snake case', () => {
    for (const code of ${upper(name)}_ERROR_CODES) {
      expect(code).toMatch(/^X_[A-Z0-9_]+$/);
    }
  });
});
`,
    },
  ];
}

export const TIER_NUMBERS: readonly number[] = Object.keys(TIERS)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * `--tier` as a real tier, or a refusal. It used to be `Number.parseInt` with no guard, so
 * `--tier abc` scaffolded a package whose own CLAUDE.md said "Tier NaN. May import tiers 0-5" —
 * and `--tier 1` scaffolded "May import tiers 0-5" too, because the allowed range was derived from
 * the package NAME and a package being created is in no tier table yet.
 */
export function tierProblem(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !TIER_NUMBERS.includes(Number.parseInt(raw, 10))) {
    return `--tier ${raw} is not one of ${TIER_NUMBERS.join(', ')}`;
  }
  return undefined;
}

function readTier(raw: string | undefined, name: string, json: boolean): number {
  const problem = tierProblem(raw);
  if (problem !== undefined) {
    report(
      {
        ok: false,
        script: 'new-package',
        summary: 'a package needs a real tier before it needs a file',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: problem,
            fix: `bun run scripts/new-package.ts ${name} --tier 1`,
          },
        ],
      },
      json,
    );
  }
  return raw === undefined ? tierOf(name) : Number.parseInt(raw, 10);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const name = args.positionals[0];
  if (name === undefined) {
    report(
      {
        ok: false,
        script: 'new-package',
        summary: 'a package name is required',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: 'no package name given',
            fix: 'bun run scripts/new-package.ts seo --tier 1',
          },
        ],
      },
      args.json,
    );
  }
  const dir = join(root, 'packages', name);
  const tier = readTier(flagString(args, 'tier'), name, args.json);
  const description = flagString(args, 'description') ?? 'One line about what this package owns';

  // `--only <path>` fills in one missing contract file in a package that already exists, which is
  // what the `package-shape` verify step tells you to run.
  const only = flagString(args, 'only');
  if (existsSync(dir) && only === undefined) {
    report(
      {
        ok: false,
        script: 'new-package',
        summary: `packages/${name} already exists`,
        findings: [
          {
            code: 'X_GENERATE_CONFLICT',
            cause: `packages/${name} is already a directory`,
            fix: `bun run scripts/new-package.ts ${name} --only README.md, or pick another name`,
            at: `packages/${name}`,
          },
        ],
      },
      args.json,
    );
  }

  const all = packageTemplates(name, tier, description);
  const files = only === undefined ? all : all.filter((file) => file.path === only);
  if (files.length === 0) {
    report(
      {
        ok: false,
        script: 'new-package',
        summary: `no template named ${only ?? ''}`,
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: `--only ${only ?? ''} is not one of the package templates`,
            fix: `bun run scripts/new-package.ts ${name} --only ${all.map((file) => file.path).join('|')}`,
          },
        ],
      },
      args.json,
    );
  }
  for (const file of files) {
    if (existsSync(join(dir, file.path))) continue;
    await Bun.write(join(dir, file.path), file.contents);
  }
  report(
    {
      ok: true,
      script: 'new-package',
      summary: `packages/${name} scaffolded at tier ${tier}`,
      lines: files.map((file) => `  + packages/${name}/${file.path}`),
      data: { name, tier, files: files.map((file) => file.path) },
    },
    args.json,
  );
}
