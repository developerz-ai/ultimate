// `exportMember`, the settings slice's `subjectExport()` job — one primitive per file.
//
// Everything `memberSubject` (`../subject.ts`) reaches, one object per page per table under the
// org's own prefix, and an `index.json` naming each table, its count and what an erase does to it.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { subjectExport, t } from '@ultimat3/jobs';
import { disk } from '@ultimat3/storage';
import { memberSubject } from '../subject';

/** Where one export lands: under its org, so a key names its tenant. */
export const memberExportPrefix = (input: {
  readonly orgId: string;
  readonly memberId: string;
  readonly exportId: string;
}) => `org/${input.orgId}/exports/members/${input.memberId}/${input.exportId}`;

export const exportMember = subjectExport({
  name: 'members.export',
  input: t.object({ orgId: t.uuid, memberId: t.uuid, exportId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  subject: memberSubject,
  prefix: memberExportPrefix,
  format: 'ndjson',
  // A thunk, read per write: this line runs at import, before boot has built the disk.
  sink: () => disk(),
});
