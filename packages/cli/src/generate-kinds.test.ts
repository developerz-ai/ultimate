// Which spelling reaches which generator. Every refusal here is a `fix:` an agent pastes into a
// shell, so the assertions are on the exact line — `x g route <name>` is a redirect, not a
// command, and that is the bug these three readers exist to keep out.

import { describe, expect, test } from 'bun:test';
import {
  assertSurfaceSupported,
  GENERATORS,
  readKind,
  readPermission,
  readSurface,
} from './generate-kinds';
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

  /**
   * `--permission` is spliced into the emitted page three times — the `permissions:` array, a
   * `definePermissions()` call and a `PermissionRegistry` augmentation — and
   * `@ultimat3/policy`'s `Permission` is `${string}:${string}`. A value without a colon was
   * accepted and written, so the failure arrived as a TS2345 in a file the caller had not written.
   */
  test('a --permission that is not a <resource>:<verb> is refused before anything is written', () => {
    for (const raw of ['ops', 'ops:', ':read', 'ops read', "ops:'read", 'ops:re:ad']) {
      const thrown = thrownBy(() => readPermission(raw, 'admin:page'));
      expect([raw, thrown.code]).toEqual([raw, 'X_CLI_BAD_FLAG']);
      expect(thrown.fix).toBe('x g admin:page ops --permission ops:read');
    }
  });

  test('the shapes an app really declares are accepted, and absence is not a value', () => {
    for (const raw of ['ops:read', 'ledger:reconcile', 'admin:*', 'billing.eu:read']) {
      expect(readPermission(raw, 'admin:page')).toBe(raw);
    }
    expect(readPermission(undefined, 'admin:page')).toBeUndefined();
  });

  test('a word near nothing gets the page, never an invented lead', () => {
    expect(thrownBy(() => readKind('zzzzzzzzzz')).fix).toBe('x help g');
  });

  // `x g --json` answered `X_CLI_UNKNOWN_COMMAND: "x g" is not a command`, which is FALSE: `g` is
  // in `x help`, the parser reaches it, and `x g route foo` runs. What was missing is the
  // generator, and `readName`'s own doc block one function down makes exactly this argument about
  // the missing `<name>`. The refusal now says which word is missing and lists the ones that fit.
  test('no kind at all is a missing subcommand, never "x g is not a command"', () => {
    const thrown = thrownBy(() => readKind(undefined));
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    expect(thrown.cause).toContain('"x g" takes a subcommand and got none');
    expect(thrown.cause).not.toContain('is not a command');
    expect(thrown.cause).not.toContain('undefined');
    for (const kind of GENERATORS) expect(thrown.cause).toContain(kind);
    // `x help g`, and not an invented lead: which of thirteen was meant is exactly what the caller
    // did not say — the same reason `x db` and `x mcp` answer with help rather than a default.
    expect(thrown.fix).toBe('x help g');
  });

  // The other half, and the one that must not move: a WORD that is not a generator is still an
  // unknown command form, because the caller did name something and it does not exist.
  test('a word that is no generator is still X_CLI_UNKNOWN_COMMAND', () => {
    expect(thrownBy(() => readKind('zzzzzzzzzz')).code).toBe('X_CLI_UNKNOWN_COMMAND');
    expect(thrownBy(() => readKind('')).code).toBe('X_CLI_UNKNOWN_COMMAND');
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
