// `requestMemberExport`, the settings slice's action — one primitive per file.
//
// An owner exporting one member's data on their request. The answer is where the artifact will
// land — `index.json` under `prefix` once `exportMember` has written it.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
import { orgAdminister } from '../../orgs/policy';
import { exportMember, memberExportPrefix } from '../jobs/export-member';

export const requestMemberExport = action({
  input: t.object({ orgId: t.uuid, memberId: t.uuid }),
  output: t.object({ exportId: t.uuid, prefix: t.string }),
  policy: orgAdminister,
  errors: [],
  idempotent: true,
  async handle({ input }) {
    const target = { ...input, exportId: crypto.randomUUID() };
    await exportMember.enqueue(target);
    return { exportId: target.exportId, prefix: memberExportPrefix(target) };
  },
});
