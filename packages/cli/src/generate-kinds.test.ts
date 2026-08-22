// Which spelling reaches which generator. Every refusal here is a `fix:` an agent pastes into a
// shell, so the assertions are on the exact line — `x g route <name>` is a redirect, not a
// command, and that is the bug these three readers exist to keep out.

import { describe, expect, test } from 'bun:test';
import { assertSurfaceSupported, GENERATORS, readKind, readSurface } from './generate-kinds';
import { thrownBy } from './thrown-by';

describe('readKind', () => {
  test('every declared generator resolves to itself', () => {
    expect(GENERATORS.length).toBeGreaterThan(0);
    for (const kind of GENERATORS) expect(readKind(kind)).toBe(kind);
  });

  test('an unknown kind names the known ones and suggests a real invocation', () => {
    const thrown = thrownBy(() => readKind('resourse'));
    expect(thrown.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(thrown.cause).toContain('"x g resourse" is not a command');
    for (const kind of GENERATORS) expect(thrown.cause).toContain(kind);
    expect(thrown.fix).toBe('x g resource invoice');
  });

  /**
   * The fix used to be the literal `x g resource`, for every typo of every generator: `x g rout x`
   * — one edit from `route` — answered with the WRONG PRIMITIVE, and answered with a command that
   * refuses in turn, because `x g resource` carries no `<name>`. `nearestName` is what the
   * top-level dispatcher already does with a mistyped command.
   */
  test('a near-miss leads with the generator it is near, and a runnable name', () => {
    for (const [raw, fix] of [
      ['rout', 'x g route posts'],
      ['jobb', 'x g job send-digest'],
      ['policies', 'x g policy post'],
      ['admin:pages', 'x g admin:page ops'],
    ] as const) {
      expect([raw, thrownBy(() => readKind(raw)).fix]).toEqual([raw, fix]);
    }
  });

  test('a word near nothing gets the page, never an invented lead', () => {
    expect(thrownBy(() => readKind('zzzzzzzzzz')).fix).toBe('x help g');
  });

  test('no kind at all is refused as `g`, not as `g undefined`', () => {
    const thrown = thrownBy(() => readKind(undefined));
    expect(thrown.code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(thrown.cause).toContain('"x g" is not a command');
    expect(thrown.cause).not.toContain('undefined');
  });
});

describe('readSurface', () => {
  test('absent means app, and both surfaces spell to themselves', () => {
    expect(readSurface(undefined, 'route', 'pricing')).toBe('app');
    expect(readSurface('app', 'route', 'pricing')).toBe('app');
    expect(readSurface('site', 'route', 'pricing')).toBe('site');
  });

  test('a typo is refused rather than falling through to app', () => {
    for (const raw of ['Site', 'pages', 'api', '']) {
      const thrown = thrownBy(() => readSurface(raw, 'route', 'pricing'));
      expect([raw, thrown.code]).toEqual([raw, 'X_CLI_BAD_FLAG']);
      expect([raw, thrown.cause]).toEqual([
        raw,
        `--surface on "x g": "${raw}" is not a surface (site, app)`,
      ]);
      // The kind and the name the caller typed, so the fix is a command and not a template.
      expect([raw, thrown.fix]).toEqual([raw, 'x g route pricing --surface app']);
    }
  });
});

describe('assertSurfaceSupported', () => {
  test('a resource on site/ is refused with the two commands that do what was meant', () => {
    const thrown = thrownBy(() => {
      assertSurfaceSupported('resource', 'site', 'pricing');
    });
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    expect(thrown.fix).toBe('x g resource pricing && x g route pricing --surface site');
    // The caller's own name, never the `<name>` placeholder a shell would read as a redirect.
    expect(thrown.fix).not.toContain('<name>');
  });

  test('every other combination is allowed', () => {
    expect(() => {
      assertSurfaceSupported('resource', 'app', 'pricing');
    }).not.toThrow();
    expect(() => {
      assertSurfaceSupported('route', 'site', 'pricing');
    }).not.toThrow();
  });
});
