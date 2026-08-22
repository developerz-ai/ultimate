// Single responsibility: the `fix:` line each policy error emits has to RUN. Both cases here
// shipped a fix that made things worse — one named a command that answers `X_DECLARATION_UNKNOWN`,
// the other told the caller to declare their own typo as a real permission — and neither is
// visible from the cause, which is why `message` alone is never the assertion.

import { describe, expect, test } from 'bun:test';
import { forbidden, permissionUnknown } from './errors';
import { allow, and, can, deny, not, or } from './policy';

describe('forbidden()', () => {
  test('a bare permission label keeps `x policy explain`, which resolves it', () => {
    // `knownPolicySubjects()` (cli's `policy-facts.ts`) holds every declared permission, so this
    // is the one label shape the command can answer.
    expect(forbidden(can('post:publish').label, 'no').fix).toContain(
      'x policy explain post:publish --json',
    );
    expect(forbidden('org_admin:read-all', 'no').fix).toContain(
      'x policy explain org_admin:read-all --json',
    );
  });

  test('a composite label falls back to `x policy list`, which is a command that exists', () => {
    // Reproduced in `examples/dummy`: `x policy explain "and(post:publish, org:administer)"` is
    // `X_DECLARATION_UNKNOWN` — a fix line that reproduces an error instead of repairing one.
    // `x policy list --json` is what `X_DECLARATION_UNKNOWN`'s own fix says when it cannot suggest.
    const composite = and(can('post:publish'), can('org:administer'));
    const fix = forbidden(composite.label, 'no').fix;
    expect(fix).toContain('x policy list --json');
    // The label is never interpolated into a command again — a `<permission>` placeholder after
    // the `#` is a shape a reader fills in, not a line they paste whole.
    expect(fix).not.toContain('and(post:publish');
  });

  test.each([
    ['or', or(can('post:publish'), can('post:review')).label],
    ['not', not(can('post:publish')).label],
    ['allow', allow().label],
    ['deny', deny('read-only mode').label],
    ['a named policy', 'PublishPost'],
    ['an empty label', ''],
  ])('%s is not a permission either, so it lists', (_name, label) => {
    expect(forbidden(label, 'no').fix).toContain('x policy list --json');
  });

  test('the cause still carries the whole label, however it renders', () => {
    const composite = and(can('post:publish'), can('org:administer'));
    expect(forbidden(composite.label, 'the actor lacks post:publish').cause).toContain(
      'and(post:publish, org:administer)',
    );
  });
});

describe('permissionUnknown()', () => {
  const KNOWN = ['billing:write', 'billing:read', 'post:publish'] as const;

  test('a typo is answered with the real permission, never with an offer to declare the typo', () => {
    // The old fix led with `add 'billing:wirte' to definePermissions([...])`, which is an
    // instruction to CREATE the typo — a second permission nothing grants and nothing enforces.
    const fix = permissionUnknown('billing:wirte', KNOWN).fix;
    expect(fix).toContain("'billing:write'");
    expect(fix.indexOf("'billing:write'")).toBeLessThan(fix.indexOf('definePermissions'));
  });

  test('a name nothing resembles keeps the declare-it path, plus the list to pick from', () => {
    const fix = permissionUnknown('warehouse:dispatch', KNOWN).fix;
    expect(fix).toContain("add 'warehouse:dispatch' to definePermissions");
    expect(fix).toContain('x policy list --json');
  });

  test('an empty permission set cannot suggest anything and says so with the declare-it path', () => {
    expect(permissionUnknown('billing:write', []).fix).toContain(
      "add 'billing:write' to definePermissions",
    );
  });

  test('the cause names the count, never the whole set', () => {
    const error = permissionUnknown('billing:wirte', KNOWN);
    expect(error.cause).toContain('"billing:wirte"');
    expect(error.cause).toContain('3 known');
    expect(error.cause).not.toContain('post:publish');
  });
});
