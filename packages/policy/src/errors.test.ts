// Single responsibility: the `fix:` line each policy error emits has to RUN. Both cases here
// shipped a fix that made things worse — one named a command that answers `X_DECLARATION_UNKNOWN`,
// the other told the caller to declare their own typo as a real permission — and neither is
// visible from the cause, which is why `message` alone is never the assertion.

import { describe, expect, test } from 'bun:test';
import {
  declaredErrorRetry,
  describeErrorCode,
  ERROR_DOCS_URL,
  hasErrorCode,
} from '@ultimat3/core';
import {
  emptyClauseList,
  forbidden,
  POLICY_ERROR_CODES,
  POLICY_ERROR_TITLES,
  permissionUnknown,
  policyMissing,
  roleRedefined,
} from './errors';
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

// `PolicyError` passes no `docs:`, so the link is whatever the registry resolved: one page for
// every code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal —
// a hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every suite
// in the tree, with the code interpolated into a fragment no page has ever had an anchor for.
// The two halves of one refusal, and they say opposite things: an empty `and()` ALLOWS everyone
// and an empty `or()` DENIES everyone, so a shared sentence would be wrong for one of them. Each
// fix names the explicit spelling for its own half, which is what makes refusing cost a caller
// nothing they cannot say another way.
describe('emptyClauseList()', () => {
  test('the and() half names what it would have allowed, and the spelling that says so', () => {
    const error = emptyClauseList('and');
    expect(error.code).toBe('X_POLICY_CLAUSE_EMPTY');
    expect(error.cause).toContain('allows every actor');
    expect(error.cause).toContain('anonymous');
    expect(error.fix).toContain("allow('public')");
  });

  test('the or() half names a denial nobody can debug, and the spelling that carries a reason', () => {
    const error = emptyClauseList('or');
    expect(error.cause).toContain('denies every actor');
    expect(error.fix).toContain("deny('<why nobody may act>')");
    // Never the `and` fix: an `allow('public')` suggested for an empty `or()` would turn a
    // fail-closed declaration bug into a public door, out of the error that reports it.
    expect(error.fix).not.toContain("allow('public')");
  });
});

describe('docs', () => {
  test('a constructed policy error points at the one page, never a per-code URL', () => {
    const errors = [
      forbidden('post:publish', 'no'),
      policyMissing('publishPost'),
      roleRedefined('admin', 'a.ts', 'b.ts'),
      permissionUnknown('billing:write', ['post:publish']),
      emptyClauseList('and'),
      emptyClauseList('or'),
    ];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
    }
  });

  test('and every owned code declares how it is retried', () => {
    // The defect `@ultimat3/scraping`'s `cdp-target.ts` names about `X_VALIDATION_FAILED`, in this
    // package's own codes: `classifyThrown` reads an UNREGISTERED code as unclassified, so the
    // attempt count governs and a job burns its whole retry policy re-proving a denial. Core's own
    // `ErrorRetry` doc names "a permission denial" as the canonical `terminal` case, and
    // `X_FORBIDDEN` — the framework's one permission-denial code — was not classified at all.
    // Every one is LISTED rather than left to the `terminal` default, which is exactly what
    // `@ultimat3/jobs`' webhook block does and for the same reason: the default is invisible to
    // `classifyThrown`.
    for (const code of POLICY_ERROR_CODES) {
      expect(declaredErrorRetry(code)).toBe('terminal');
    }
  });

  test('and every owned code is registered with its title and that same link', () => {
    for (const code of POLICY_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(POLICY_ERROR_TITLES[code]);
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });
});
