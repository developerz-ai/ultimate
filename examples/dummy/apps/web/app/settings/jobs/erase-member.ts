// `eraseMember`, the settings slice's `subjectErase()` job — one primitive per file.
//
// Runs `memberSubject` (`../subject.ts`) for one member of one org: avatars first, then each table
// children first, the member row last. Resumable: a killed run picks up at the page it stopped on.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { subjectErase, t } from '@ultimat3/jobs';
import { memberSubject } from '../subject';

export const eraseMember = subjectErase({
  name: 'members.erase',
  input: t.object({ orgId: t.uuid, memberId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  subject: memberSubject,
});
