// D1 and D11, as text: what `x g action` and `x g mutator` emit depends on what the slice declares,
// so a hand-written policy gets no constants its contract test never reads, and an entity with no
// tenant gets no `orgId`. That the text also passes Biome and `tsc` is `emitted-contract.test.ts`'s
// and `scaffold-typecheck.contract.test.ts`'s, over the same shapes in `FIXTURE_GENERATORS`.

import { describe, expect, test } from 'bun:test';
import {
  HANDWRITTEN_ENTITY_NO_TENANT,
  HANDWRITTEN_POLICY,
  HANDWRITTEN_REPO_NO_TENANT,
  INVOICE_ENTITY,
} from '../scaffold-fixture';
import { actionFiles } from './action';
import { policyReadsOrg, sliceHasNoTenant } from './slice-foundation';

const slice = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;
type Options = Parameters<typeof actionFiles>[1];

const sourceOf = (files: ReturnType<typeof actionFiles>, suffix: string): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

const SINGLE_TENANT: Options = {
  ...slice,
  sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
  sliceRepo: HANDWRITTEN_REPO_NO_TENANT,
};

describe('unit · the contract test names only what it reads', () => {
  for (const mutator of [false, true]) {
    const kind = mutator ? 'mutator' : 'action';
    test(`${kind}, a hand-written policy: no id, orgId, input or outsider`, () => {
      const text = sourceOf(
        actionFiles('close-invoice', {
          ...slice,
          mutator,
          sliceEntity: INVOICE_ENTITY,
          slicePolicy: HANDWRITTEN_POLICY,
        }),
        'close-invoice.contract.test.ts',
      );
      for (const binding of ['id', 'orgId', 'input', 'outsider']) {
        expect(text).not.toMatch(new RegExp(`^const ${binding}\\b`, 'm'));
      }
      expect(text).not.toContain('testActor');
      expect(text).toContain('../policy.ts is hand-written');
    });

    test(`${kind}, the policy this run writes: all four, and the foreign-org denial`, () => {
      const text = sourceOf(
        actionFiles('close-invoice', { ...slice, mutator, sliceEntity: INVOICE_ENTITY }),
        'close-invoice.contract.test.ts',
      );
      for (const binding of ['id', 'orgId', 'input', 'outsider']) {
        expect(text).toMatch(new RegExp(`^const ${binding}\\b`, 'm'));
      }
      expect(text).toContain('denies a foreign org');
    });
  }
});

describe('unit · an entity with no tenant gets no org', () => {
  for (const mutator of [false, true]) {
    const kind = mutator ? 'mutator' : 'action';
    test(`${kind}: no orgId in the input, either test, or the policy it plants`, () => {
      const files = actionFiles('ship-link', { ...SINGLE_TENANT, mutator });
      for (const suffix of [
        'ship-link.ts',
        'ship-link.test.ts',
        'ship-link.contract.test.ts',
        '/policy.ts',
        '/policy.test.ts',
      ]) {
        expect(sourceOf(files, suffix)).not.toContain('orgId');
      }
      expect(sourceOf(files, 'ship-link.ts')).toContain(
        mutator
          ? 'input: t.object({ id: t.uuid, title: t.string }),'
          : 'input: t.object({ id: t.uuid }),',
      );
      expect(sourceOf(files, '/policy.ts')).toContain("can('invoice:write')");
    });
  }

  test('a policy still deciding on input.orgId keeps it in the input: the action must compile', () => {
    const files = actionFiles('ship-link', {
      ...SINGLE_TENANT,
      slicePolicy: `import { tag } from '@ultimat3/cache';
import { can } from '@ultimat3/policy';
export const invoiceTag = tag('invoice');
export const canInvoiceWrite = can<InvoiceScope>('invoice:write', ({ actor, input }) => actor?.orgId === input.orgId);
`,
    });
    expect(sourceOf(files, 'ship-link.ts')).toContain('orgId: t.uuid');
  });

  test('a policy that stopped reading it, the single-tenant edit, is what drops it', () => {
    const files = actionFiles('ship-link', { ...SINGLE_TENANT, slicePolicy: HANDWRITTEN_POLICY });
    expect(sourceOf(files, 'ship-link.ts')).not.toContain('orgId');
    expect(sourceOf(files, 'ship-link.test.ts')).not.toContain('orgId');
  });

  test('a body that reads no row plants no errors.ts: nothing would import it', () => {
    const paths = actionFiles('ship-link', SINGLE_TENANT).map((file) => file.path);
    expect(paths).not.toContain('apps/web/app/invoice/errors.ts');
    const scaffold = actionFiles('ship-link', { ...slice, sliceEntity: INVOICE_ENTITY });
    expect(scaffold.map((file) => file.path)).toContain('apps/web/app/invoice/errors.ts');
  });

  test('no entity at all is the default shape, unchanged', () => {
    const files = actionFiles('ship-link', slice);
    expect(sourceOf(files, 'ship-link.ts')).toContain('orgId: t.uuid');
    expect(sourceOf(files, '/policy.ts')).toContain('input.orgId');
  });
});

describe('unit · sliceHasNoTenant reads the three ways tenancy turns on', () => {
  const columns = 'columns: { id: uuid().primaryKey(), url: text({ max: 9 }) },';
  test.each([
    ['tenant named', `tenant: 'orgId', ${columns}`, false],
    ['.tenant() on a column', 'columns: { team: uuid().tenant() },', false],
    ['inferred from a column named orgId', 'columns: { orgId: uuid() },', false],
    ['none of the three', columns, true],
    ["tenant: 'none'", `tenant: 'none', ${columns}`, true],
    ['a comment naming it', `// tenant: 'orgId'\n${columns}`, true],
  ])('%s', (_name, source, expected) => {
    expect(sliceHasNoTenant(source)).toBe(expected);
  });

  test('no entity decided nothing', () => {
    expect(sliceHasNoTenant(undefined)).toBe(false);
  });

  test('policyReadsOrg sees the rule and the type, and not a comment or the actor', () => {
    expect(policyReadsOrg("can<S>('a:b', ({ input }) => input.orgId === '1')")).toBe(true);
    expect(policyReadsOrg("can<PostScope>('a:b')")).toBe(true);
    expect(policyReadsOrg("// input.orgId\ncan('a:b')")).toBe(false);
    expect(policyReadsOrg("can('a:b', ({ actor }) => actor.orgId !== '')")).toBe(false);
  });
});
