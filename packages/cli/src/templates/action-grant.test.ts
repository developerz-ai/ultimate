// The unit test `x g action` writes into a slice whose `policy.ts` an author wrote. The failure
// first: the generated test granted `<feature>:write` and expected the handler to answer — but a
// handwritten `canBlogWrite = can('blog:publish')` needs another permission, so the test a
// generator promised to ship passing failed on the first run. The grant is read off the policy
// when it is one literal `can('<perm>')`; when it cannot be read, no assertion depends on it.

import { describe, expect, test } from 'bun:test';
import { INVOICE_ENTITY } from '../scaffold-fixture';
import { actionFiles } from './action';
import { FRESH_ACTION_OUTPUT } from './action-fresh-fixture';

const slice = { surfaceDir: 'apps/web/app', feature: 'blog' } as const;
const BOTH = "import { tag } from '@ultimat3/cache';\nexport const blogTag = tag('blog');\n";
const PUBLISH = `${BOTH}import { can } from '@ultimat3/policy';\nexport const canBlogWrite = can('blog:publish');\n`;
const COMPOSITE = `${BOTH}import { can, or } from '@ultimat3/policy';\nexport const canBlogWrite = or(can('blog:publish'), can('blog:admin'));\n`;

const sourceOf = (files: ReturnType<typeof actionFiles>, suffix: string): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

describe('unit · a handwritten single-permission policy: the test grants exactly that permission', () => {
  for (const mutator of [false, true]) {
    test(mutator ? 'mutator' : 'action', () => {
      const files = actionFiles('write-article', { ...slice, mutator, slicePolicy: PUBLISH });
      const unit = sourceOf(files, 'write-article.test.ts');
      expect(unit).toContain("const grant = ['blog:publish'];");
      expect(unit).not.toContain('blog:write');
      expect(unit).toContain('the handler answers a writer in the org');
      const contract = sourceOf(files, 'write-article.contract.test.ts');
      expect(contract).not.toContain('blog:write');
    });
  }
});

describe('unit · a policy whose grant cannot be read: no assertion depends on it', () => {
  for (const policy of [COMPOSITE, `${BOTH}export const canBlogWrite = makeRule();\n`]) {
    test(policy.includes('or(') ? 'or(can, can)' : 'a function call', () => {
      const files = actionFiles('write-article', { ...slice, slicePolicy: policy });
      const unit = sourceOf(files, 'write-article.test.ts');
      expect(unit).not.toContain('const grant');
      expect(unit).not.toContain('the handler answers');
      expect(unit).toContain('is a declared action');
      expect(unit).toContain('rejects input that is not a uuid');
      expect(unit).toMatch(/\/\/ No handler assertion: .*policy\.ts/);
    });
  }

  test('a slice with an entity drops its lookup tests too: they run as a writer', () => {
    const files = actionFiles('send-invoice', {
      surfaceDir: 'apps/web/app',
      feature: 'invoice',
      sliceEntity: INVOICE_ENTITY,
      slicePolicy:
        "import { tag } from '@ultimat3/cache';\nexport const invoiceTag = tag('invoice');\nexport const canInvoiceWrite = rule;\n",
    });
    const unit = sourceOf(files, 'send-invoice.test.ts');
    expect(unit).not.toContain('writer');
    expect(unit).not.toContain('repo.insert');
  });
});

describe('unit · a fresh slice is generated exactly as before', () => {
  test('byte for byte', () => {
    const now = {
      freshNoEntity: actionFiles('write-article', slice),
      freshMutator: actionFiles('write-article', { ...slice, mutator: true }),
      freshEntity: actionFiles('send-invoice', {
        surfaceDir: 'apps/web/app',
        feature: 'invoice',
        sliceEntity: INVOICE_ENTITY,
      }),
    };
    for (const [key, files] of Object.entries(now)) {
      const actions = files
        .filter((file) => file.path.includes('/actions/'))
        .map((file) => ({ path: file.path, contents: file.contents }));
      expect(actions, key).toEqual(FRESH_ACTION_OUTPUT[key] as typeof actions);
    }
  });
});
