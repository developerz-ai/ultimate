// What `x g` says when it could NOT grant what it declared. The role-map edit lands in the
// scaffold's `apps/web/shared/roles.ts`; an app whose roles live elsewhere got no grant and no
// word — every generated endpoint then answered 403, found one `x verify` later, or by a user.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { ungrantedByGenerator } from './generate-grant-findings';
import { grantGeneratedPermissions } from './generate-grants';
import { ROLES_FILE } from './permission-grants';
import { rolesFiles } from './templates/scaffold-roles';

const POLICY = 'apps/web/app/run/policy.ts';
const ENTITY = 'apps/web/app/run/entity.ts';
const WRITTEN = [POLICY, ENTITY];

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-grants-'));
  await Bun.write(join(root, ENTITY), "export const run = entity('runs', { columns: {} });\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const scaffoldRoles = (): string => {
  const file = rolesFiles().find((one) => one.path === ROLES_FILE);
  return typeof file?.contents === 'string' ? file.contents : expect.unreachable('no role map');
};

describe('unit · a grant the generator could not make is a finding with the lines to add', () => {
  test('the scaffold role map takes every grant: nothing to report', async () => {
    await Bun.write(join(root, ROLES_FILE), scaffoldRoles());
    expect(await grantGeneratedPermissions(root, WRITTEN)).toEqual([ROLES_FILE]);
    expect(await ungrantedByGenerator(root, WRITTEN)).toEqual([]);
  });

  test('an app with no apps/web/shared/roles.ts is told what nobody granted, per role', async () => {
    expect(await grantGeneratedPermissions(root, WRITTEN)).toEqual([]);
    const findings = await ungrantedByGenerator(root, WRITTEN);
    expect(findings.map((finding) => finding.code)).toEqual(['X_PERMISSION_UNGRANTED']);
    const [finding] = findings;
    expect(finding?.cause).toContain(`${ROLES_FILE} is not in this app`);
    // The lines, exactly: which permission goes in which role's `grants`.
    expect(finding?.fix).toContain("member: 'run:read'");
    expect(finding?.fix).toContain("admin: 'run:write', 'runs:read', 'runs:write', 'runs:delete'");
    // And a command first: the file is the app's own, so the fix names how to find it.
    expect(finding?.fix).toStartWith('x policy list --json');
    expect(finding?.at).toBe(POLICY);
  });

  test('a role map that is there but has no such role names the file and the same lines', async () => {
    const custom =
      "import { defineRoles } from '@ultimat3/policy';\n\ndefineRoles({\n  owner: { grants: ['*'] },\n});\n";
    await Bun.write(join(root, ROLES_FILE), custom);
    expect(await grantGeneratedPermissions(root, WRITTEN)).toEqual([]);
    const [finding] = await ungrantedByGenerator(root, WRITTEN);
    expect(finding?.code).toBe('X_PERMISSION_UNGRANTED');
    expect(finding?.fix).toStartWith(`edit ${ROLES_FILE} — `);
    expect(finding?.fix).toContain("member: 'run:read'");
    expect(finding?.at).toBe(ROLES_FILE);
    expect(await Bun.file(join(root, ROLES_FILE)).text()).toBe(custom);
  });

  test('a run that wrote no policy and no entity implies no grant and reports nothing', async () => {
    expect(await ungrantedByGenerator(root, ['apps/web/app/run/jobs/reindex-run.ts'])).toEqual([]);
  });
});
