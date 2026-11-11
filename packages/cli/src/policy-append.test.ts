// The merge `x g policy <name> --feature <slice>` applies to a slice's `policy.ts`: the author's
// bytes kept, imports folded rather than repeated, and the same set again refused, not doubled.

import { describe, expect, test } from 'bun:test';
import { appendPolicy } from './policy-append';
import { policyFiles } from './templates/policy';

const slice = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;
const source = (name: string): string => String(policyFiles(name, slice)[0]?.contents);

describe('unit · appendPolicy', () => {
  test('keeps every byte the author had and adds the new set after it', () => {
    const merged = appendPolicy(source('invoice'), source('approval')) ?? '';
    const [head = '', tail = ''] = merged.split("'approval:read': true;");
    expect(head).toContain('export const canInvoiceCreate');
    expect(tail).toContain('export const canApprovalCreate');
    expect(merged.match(/^import /gm)?.length).toBe(2);
  });

  test('folds a wrapped import and places a missing one in specifier order', () => {
    const wrapped =
      "import {\n  can,\n  or,\n} from '@ultimat3/policy';\nexport const canX = can('x:y');\n";
    const merged = appendPolicy(wrapped, source('approval')) ?? '';
    expect(merged).toStartWith(
      "import { tag } from '@ultimat3/cache';\nimport { can, definePermissions, or } from '@ultimat3/policy';\n",
    );
    expect(merged.match(/from '@ultimat3\/policy'/g)?.length).toBe(1);
  });

  test('the same set again does not merge', () => {
    expect(appendPolicy(source('invoice'), source('invoice'))).toBeUndefined();
  });
});
