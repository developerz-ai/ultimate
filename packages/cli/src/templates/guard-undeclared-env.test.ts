// The `undeclared-env` guard as the gate runs it: a raw read of a name `app.config.ts` never
// declared used to pass typecheck, lint, boundaries and errors, while the typed `env.X` failed tsc.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory, symlink or mkdir API; `node:fs/promises` is the only one.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { undeclaredEnvGuardFiles } from './guard-undeclared-env';
import { shippedGuardFindings } from './shipped-guard-fixture';

/** What `x new` writes, abridged: an `envSchema` export handed to `defineEnv`. */
const SCHEMA = [
  "import type { EnvSchema } from '@ultimat3/core';",
  "import { defineEnv } from '@ultimat3/core';",
  'export const envSchema = {',
  "  STRIPE_WEBHOOK_SECRET: { type: 'string', required: false, description: 'Compose: a: b' },",
  "  PLAN: { type: 'enum', values: ['FREE', 'PRO'] },",
  '} satisfies EnvSchema;',
  'export const env = defineEnv(envSchema);',
  '',
].join('\n');

const at = (findings: readonly { readonly at?: string }[]) => findings.map((finding) => finding.at);

describe('unit · shipped guard · undeclared-env', () => {
  test('each read form of an undeclared name is refused, in apps/ and packages/', async () => {
    const findings = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': SCHEMA,
      'apps/web/app/billing/service.ts': "export const key = process.env.STRIPE_KEY ?? '';\n",
      'apps/web/app/billing/b.ts': "export const b = Bun.env['STRIPE_KEY'];\n",
      'packages/domain/src/c.tsx': 'export const c = import.meta.env.PUBLIC_KEY;\n',
      'packages/domain/src/d.ts': 'export const d = process.env["LEGACY_TOKEN"];\n',
      // A template's `${…}` is code: the read inside it is a read.
      'packages/domain/src/e.ts': 'export const e = `key=${process.env.TEMPLATED}`;\n',
    });
    expect(at(findings).sort()).toEqual([
      'apps/web/app/billing/b.ts',
      'apps/web/app/billing/service.ts',
      'packages/domain/src/c.tsx',
      'packages/domain/src/d.ts',
      'packages/domain/src/e.ts',
    ]);
    const first = findings.find((finding) => finding.at === 'apps/web/app/billing/service.ts');
    expect(first?.code).toBe('X_UNDECLARED_ENV');
    expect(first?.cause).toContain('apps/web/app/billing/service.ts:1');
    expect(first?.cause).toContain('process.env.STRIPE_KEY');
    // The fix IS the declaration to add, and the typed read that replaces the raw one.
    expect(first?.fix).toContain("STRIPE_KEY: { type: 'string'");
    expect(first?.fix).toContain('app.config.ts');
    expect(first?.fix).toContain('env.STRIPE_KEY');
    // Opened by the line to paste into envSchema (X_FIX_PROSE: a fix opens with code).
    expect(first?.fix?.startsWith("STRIPE_KEY: { type: 'string'")).toBe(true);
    // A build-time constant (`bun build --define process.env.X=…`, an adopter's agent version) is
    // no runtime env: the fix's second branch declares a global and defines it at build instead.
    expect(first?.fix).toContain('declare const STRIPE_KEY: string');
    expect(first?.fix).toContain('bun build --define STRIPE_KEY=\'"…"\'');
  });

  // The lookalikes: a declared name, the framework's own (exact and under a prefix), NODE_ENV, a
  // computed key, the whole env handed on, a test, an e2e fixture and a comment.
  test('a declared, framework or computed read, a test and a comment are not reported', async () => {
    const findings = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': SCHEMA,
      'apps/web/app/a.ts': [
        'export const a = process.env.STRIPE_WEBHOOK_SECRET;',
        "export const b = Bun.env['PLAN'];",
        'export const c = Bun.env.DATABASE_URL ?? Bun.env.NODE_ENV ?? Bun.env.ULTIMATE_ENV;',
        'export const d = (name: string) => Bun.env[name];',
        'export const e = { env: Bun.env };',
        '// process.env.NOT_READ is a note',
        '',
      ].join('\n'),
      // A name quoted in prose or data is no read (a generated docs file, measured on an adopter),
      // and the OS's own PATH, handed to a child process, is nothing a deploy declares.
      'packages/domain/src/kb.generated.ts': [
        'export const doc = "set process.env.API_TOKEN, then call";',
        "export const two = 'or Bun.env[\\'API_TOKEN\\'] in a script';",
        'export const tpl = `export TOKEN=${1} and read process.env.API_TOKEN`;',
        "export const env = { PATH: Bun.env.PATH ?? '' };",
        '',
      ].join('\n'),
      'apps/web/app/a.test.ts': 'export const t = process.env.STRIPE_KEY;\n',
      'apps/web/e2e/fixtures/app.ts': 'export const f = process.env.E2E_ONLY;\n',
    });
    expect(findings).toEqual([]);
  });

  // A declaration's own keys (`type`, `values`, `description`'s `Compose:`) are not names.
  test("a declaration's own keys are not declared names", async () => {
    const typeRead = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': SCHEMA,
      'apps/web/app/a.ts': 'export const a = [process.env.type, process.env.Compose];\n',
    });
    expect(typeRead).toHaveLength(2);
  });

  // One declaration form. `defineEnv` returns VALUES, so a record handed to it inline is gone
  // afterwards: `x env check`, `x env example`, `x secrets` and `x deploy` read `envSchema` only.
  test('an env declared anywhere but the envSchema export is refused, naming the conversion', async () => {
    const inline = await shippedGuardFindings('undeclared-env', {
      'app.config.ts':
        "export const env = defineEnv({\n  // --- billing ---\n  STRIPE_KEY: { type: 'string' },\n});\n",
      'apps/web/app/a.ts': 'export const a = process.env.STRIPE_KEY;\n',
    });
    const form = inline.find((finding) => finding.at === 'app.config.ts');
    expect(form?.code).toBe('X_UNDECLARED_ENV');
    expect(form?.cause).toContain('app.config.ts:1');
    expect(form?.fix).toContain('export const envSchema = {');
    expect(form?.fix).toContain('export const env = defineEnv(envSchema);');
    // Its keys are not declared: the read is reported too, until the conversion lands.
    expect(at(inline)).toContain('apps/web/app/a.ts');
    const named = await shippedGuardFindings('undeclared-env', {
      'app.config.ts':
        "const schema = { A: { type: 'string' } };\nexport const env = defineEnv(schema);\n",
    });
    expect(at(named)).toEqual(['app.config.ts']);
    // The one form, and a comment naming the other, are silence.
    const one = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': `${SCHEMA}// not defineEnv({ … }) inline\n`,
    });
    expect(one).toEqual([]);
  });

  // A record handed to `defineEnv` in app source is a declaration `x env` never reads: its keys
  // must already be envSchema's. The agent shape's `model.ts` builds one from envSchema: allowed.
  test('a defineEnv record outside app.config.ts declaring a name envSchema does not is refused', async () => {
    const findings = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': SCHEMA,
      'apps/web/api/ping.ts': [
        "import { defineEnv } from '@ultimat3/core';",
        "export const env = defineEnv({ PING_TOKEN: { type: 'string' } });",
        'export const read = () => env.PING_TOKEN;',
        '',
      ].join('\n'),
      'packages/domain/src/named.ts': [
        "const local = { PLAN: envSchema.PLAN, HIDDEN_KEY: { type: 'string' } } satisfies EnvSchema;",
        'export const env = defineEnv(local, { env: source });',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => [finding.at, finding.cause.split(' ')[0]])).toEqual([
      ['apps/web/api/ping.ts', 'apps/web/api/ping.ts:2'],
      ['packages/domain/src/named.ts', 'packages/domain/src/named.ts:2'],
    ]);
    expect(findings[0]?.cause).toContain('PING_TOKEN');
    expect(findings[0]?.fix).toContain("PING_TOKEN: { type: 'string'");
    expect(findings[1]?.cause).toContain('HIDDEN_KEY');
    expect(findings[1]?.cause).not.toContain('PLAN');
  });

  test('a defineEnv record built from envSchema, or envSchema itself, is not reported', async () => {
    const findings = await shippedGuardFindings('undeclared-env', {
      'app.config.ts': SCHEMA,
      'apps/web/app/assistant/model.ts': [
        'const modelEnv = {',
        '  PLAN: need(envSchema.PLAN),',
        '  STRIPE_WEBHOOK_SECRET: envSchema.STRIPE_WEBHOOK_SECRET,',
        '} satisfies EnvSchema;',
        'export const read = (source: Source) => defineEnv(modelEnv, { env: source });',
        'export const all = () => defineEnv(envSchema);',
        "export const note = 'defineEnv({ NOT_CODE: 1 })';",
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  });

  // No declaration at all is not "nothing to check": every app-owned read is undeclared.
  test('an app with no env declaration has every app-owned read reported', async () => {
    const findings = await shippedGuardFindings('undeclared-env', {
      'apps/web/app/a.ts': 'export const a = process.env.STRIPE_KEY ?? process.env.PORT;\n',
    });
    expect(findings.map((finding) => finding.cause.includes('STRIPE_KEY'))).toEqual([true]);
  });

  // The rule's own test, as `x g guard` would land it beside a copy: it must pass where it lands.
  test('the test it ships beside the rule passes in an app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-guard-undeclared-env-test-'));
    try {
      for (const file of undeclaredEnvGuardFiles()) {
        await Bun.write(join(root, file.path), file.contents);
      }
      await mkdir(join(root, 'node_modules/@ultimat3'), { recursive: true });
      for (const pkg of ['testing', 'cli']) {
        const target = Bun.fileURLToPath(new URL(`../../../${pkg}`, import.meta.url));
        await symlink(target, join(root, `node_modules/@ultimat3/${pkg}`));
      }
      const run = Bun.spawnSync(['bun', 'test', './guards/undeclared-env.test.ts'], {
        cwd: root,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const said = run.stderr.toString();
      expect(said, said).toContain(' 3 pass');
      expect(run.exitCode, said).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
