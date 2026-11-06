// `x errors explain <CODE> --recent` — the code's explanation, then what this app has seen of it:
// its groups in `x_error_groups` (count, first and last seen) and the replayable bundles
// `x_failures` holds, each with the `x repro` line that turns it into a failing test.

import { postgresErrorGroupsStore } from '@ultimat3/admin/error-groups';
import { postgresFailureStore } from '@ultimat3/db';
import { requireAppRoot } from './app-root';
import type { CommandContext } from './command';
import { withJobDriver } from './jobs-driver';
import type { CommandResult, JsonValue } from './output';

/** The newest groups read to find this code's: the store's own ceiling (`ERROR_GROUPS_MAX_LIMIT`). */
const GROUPS_READ = 500;

/** `explained` with the app's own sightings of `code` folded into its lines and its data. */
export function withRecent(
  ctx: CommandContext,
  code: string,
  explained: CommandResult,
): Promise<CommandResult> {
  const root = requireAppRoot('errors explain --recent', ctx.cwd).dir;
  return withJobDriver(root, ctx, async () => {
    const groups = (await postgresErrorGroupsStore().list({ limit: GROUPS_READ })).filter(
      (group) => group.code === code,
    );
    const bundles = await postgresFailureStore().list({ code });
    const recent: JsonValue = {
      groups: groups.map((group) => ({
        fingerprint: group.fingerprint,
        operation: group.operation,
        count: group.count,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
        status: group.status,
      })),
      bundles: bundles.map((bundle) => ({
        ...bundle,
        repro: `x repro ${bundle.id} --write --verify`,
      })),
    };
    const lines = [
      ...(explained.lines ?? []),
      `  recent: ${groups.length} group(s), ${bundles.length} captured bundle(s)`,
      ...groups.map(
        (group) =>
          `    ${group.fingerprint}  ${String(group.count).padStart(6)}×  last ${group.lastSeen}  ${group.operation ?? ''}`,
      ),
      ...bundles.map(
        (bundle) => `    x repro ${bundle.id} --write --verify   # ${bundle.name} at ${bundle.at}`,
      ),
    ];
    const data =
      typeof explained.data === 'object' &&
      explained.data !== null &&
      !Array.isArray(explained.data)
        ? explained.data
        : {};
    return { ...explained, lines, data: { ...data, recent } };
  });
}
