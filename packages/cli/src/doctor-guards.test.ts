// The listing `x doctor` adds for an app that predates a shipped guard: it has to name every
// guard the app lacks with a command that really writes it, and it must never turn a deliberate
// deletion into a failure.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  differingShippedGuards,
  missingShippedGuards,
  shippedGuardsProbe,
  withGuardListing,
} from './doctor-guards';
import { generate } from './generate-files';
import { SHIPPED_GUARD_NAMES, scaffoldGuardFiles, shippedGuardFiles } from './templates';

describe('unit · x doctor · shipped guards the app does not hold', () => {
  test('an app with no guards/ lacks every one, each with the command that adds it', () => {
    const missing = missingShippedGuards([]);
    expect(missing.map((guard) => guard.name)).toEqual([...SHIPPED_GUARD_NAMES]);
    expect(missing.find((guard) => guard.name === 'raw-length')?.add).toBe('x g guard raw-length');
  });

  test("a guard the app holds is not listed, and its own guards are not the framework's business", () => {
    const present = ['guards/raw-length.ts', 'guards/raw-colour.tsx', 'guards/migration-safety.ts'];
    const names = missingShippedGuards(present).map((guard) => guard.name);
    expect(names).not.toContain('raw-length');
    expect(names).not.toContain('raw-colour');
    expect(names).toHaveLength(SHIPPED_GUARD_NAMES.length - 2);
  });

  // The command is only an instruction if running it clears the line it came from.
  test('every `add` line is a generator call that writes exactly the guard it names', () => {
    for (const { name, add } of missingShippedGuards([])) {
      const [, verb, kind, argument] = add.split(' ');
      expect([verb, kind, argument]).toEqual(['g', 'guard', name]);
      expect(generate({ kind: 'guard', name }).map((file) => file.path)).toContain(
        `guards/${name}.ts`,
      );
    }
  });

  test('the probe reads the directory the gate reads, and never counts a test as a guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      for (const file of scaffoldGuardFiles()) {
        if (!file.path.startsWith('guards/raw-length'))
          await Bun.write(join(root, file.path), file.contents);
      }
      // Only the TEST of the missing one is present: that is not the guard.
      await Bun.write(join(root, 'guards/raw-length.test.ts'), '');
      expect(await shippedGuardsProbe(root)).toEqual([
        { name: 'raw-length', add: 'x g guard raw-length' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A listing, never a finding: the verdict, the summary and the findings are what they were.
  test('the listing rides beside the verdict and never moves it', () => {
    const clean = {
      ok: true,
      command: 'doctor',
      summary: 'clean',
      findings: [],
      data: { count: 0 },
    };
    const missing = missingShippedGuards(
      SHIPPED_GUARD_NAMES.filter((name) => name !== 'raw-length').map(
        (name) => `guards/${name}.ts`,
      ),
    );
    const listed = withGuardListing(clean, missing);
    expect([listed.ok, listed.summary, listed.findings]).toEqual([true, 'clean', []]);
    expect(listed.data).toEqual({
      count: 0,
      guards: { missing: [{ name: 'raw-length', add: 'x g guard raw-length' }], differs: [] },
    });
    // The human half carries exactly what the JSON half does: the command, runnable as printed.
    expect(listed.lines?.at(-1)).toBe('  x g guard raw-length');
    expect(listed.lines?.[0]).toContain('1 shipped guard(s)');
  });

  test('an app holding every shipped guard gets an empty list and no extra line', () => {
    const red = { ok: false, command: 'doctor', summary: '1 finding(s)', data: { count: 1 } };
    const listed = withGuardListing(red, []);
    expect(listed.ok).toBe(false);
    expect(listed.lines).toBeUndefined();
    expect(listed.data).toEqual({ count: 1, guards: { missing: [], differs: [] } });
  });
});

// Owner decision 8 (#648): shipped guards stay copies the app owns, so a fix to one never reached
// an app that already held it — `x doctor` said nothing, because it only listed what was MISSING.
// It now also lists a held shipped guard that is not the current template, with the command that
// rewrites it. Still a listing: an app may have edited its copy on purpose.
describe('unit · x doctor · a shipped guard the app holds in an older or edited form', () => {
  const template = (name: string): string => {
    const contents = shippedGuardFiles(name)?.find(
      (file) => file.path === `guards/${name}.ts`,
    )?.contents;
    return typeof contents === 'string' ? contents : '';
  };

  test('a copy that is not the current template is listed, with the command that rewrites it', () => {
    const stale = `${template('raw-length')}\n// an older rule\n`;
    expect(differingShippedGuards([{ path: 'guards/raw-length.ts', source: stale }])).toEqual([
      { name: 'raw-length', refresh: 'x g guard raw-length --force' },
    ]);
  });

  test('the current template is not listed, whatever line endings the checkout wrote', () => {
    const crlf = template('bare-error').replaceAll('\n', '\r\n');
    expect(template('bare-error').length).toBeGreaterThan(0);
    expect(
      differingShippedGuards([
        { path: 'guards/raw-length.ts', source: template('raw-length') },
        { path: 'guards/bare-error.ts', source: crlf },
      ]),
    ).toEqual([]);
  });

  test("the app's own guards are never compared: there is no template to differ from", () => {
    expect(
      differingShippedGuards([{ path: 'guards/migration-safety.ts', source: 'export {};' }]),
    ).toEqual([]);
  });

  test('the probe lists the missing and the differing guards together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      for (const file of scaffoldGuardFiles()) {
        if (file.path.startsWith('guards/focus-visible')) continue;
        const edited = file.path === 'guards/raw-length.ts' ? `${file.contents}// edit\n` : null;
        await Bun.write(join(root, file.path), edited ?? file.contents);
      }
      expect(await shippedGuardsProbe(root)).toEqual([
        { name: 'focus-visible', add: 'x g guard focus-visible' },
        { name: 'raw-length', refresh: 'x g guard raw-length --force' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the listing carries both halves, JSON and printed alike', () => {
    const listed = withGuardListing({ ok: true, command: 'doctor', summary: 'clean' }, [
      { name: 'raw-length', refresh: 'x g guard raw-length --force' },
    ]);
    expect(listed.data).toEqual({
      guards: {
        missing: [],
        differs: [{ name: 'raw-length', refresh: 'x g guard raw-length --force' }],
      },
    });
    expect(listed.lines?.[0]).toContain('1 shipped guard(s) differ');
    expect(listed.lines?.at(-1)).toBe('  x g guard raw-length --force');
  });
});
