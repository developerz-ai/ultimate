// The codemods an app still owes, for `x doctor`: an `x upgrade` driven by a CLI older than the
// engine applied none, and the installed CLI's gate cannot write. A dry run of every codemod up to
// this CLI's release names them; `x upgrade --json` at the target then applies them (idempotent).

import type { Finding } from '../output';
import type { Codemod } from './codemod';
import { runCodemods } from './engine';
import { fsCodemodApp } from './engine-fs';
import { CODEMODS } from './index';

export const CODEMODS_PENDING = 'X_UPGRADE_CODEMODS_PENDING';

export async function pendingCodemodFindings(
  root: string,
  to: string,
  codemods: readonly Codemod[] = CODEMODS,
): Promise<readonly Finding[]> {
  const report = await runCodemods({
    app: fsCodemodApp(root),
    codemods,
    from: '0.0.0',
    to,
    dryRun: true,
  });
  const owed = report.applied.filter((one) => one.changed.length > 0);
  if (owed.length === 0) return [];
  const files = [...new Set(owed.flatMap((one) => one.changed))].sort();
  return [
    {
      code: CODEMODS_PENDING,
      cause: `${String(files.length)} file(s) still as an older scaffold wrote them, owed by ${owed.map((one) => `${one.id} (${one.since})`).join(', ')}: the x upgrade that installed ${to} ran under a CLI with no codemods — ${files.slice(0, 8).join(', ')}`,
      fix: 'x upgrade --json   # on a clean tree; at the release it is on, it applies every codemod still owed',
      at: files[0] ?? '.',
    },
  ];
}
