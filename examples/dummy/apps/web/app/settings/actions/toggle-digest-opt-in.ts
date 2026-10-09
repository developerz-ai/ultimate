// `toggleDigestOptIn`, the settings slice's mutator — one primitive per file, the layout `x g` writes.
//
// The two preference toggles that want to feel instant and survive offline — unlike the bulk
// form `savePreferences` submits, which is a deliberate "Save" click. Both route through the same
// `orgs.savePreferences` partial write that action uses, so there is exactly one place a
// preference lands in the database however it got there.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: a mutator file imports one package.

import { members, tag } from '@postly/db';
import { custom, mutator, t } from '@ultimat3/action';
import type { MemberView } from '../../orgs/entity';
import { memberSelf } from '../../orgs/policy';

export const toggleDigestOptIn = mutator({
  input: t.object({ memberId: t.uuid, digestOptIn: t.boolean }),
  output: members.$schema,
  policy: memberSelf,
  idempotent: true,
  cache: { invalidates: [tag.member] },
  mcp: { expose: true, description: 'Toggle the acting member’s digest subscription' },
  local(tx, { memberId, digestOptIn }) {
    tx.member.update(memberId, () => ({ digestOptIn }));
  },
  async server(ctx, { digestOptIn }) {
    return ctx.orgs.savePreferences({ digestOptIn });
  },
  // Compliance, not preference — the one place `last-write-wins` is the wrong default. An
  // unsubscribe the server already recorded must stay unsubscribed even if a stale offline
  // toggle races it back on; a resubscribe has no such rule, so only the `false` side is sticky.
  //
  // The server row is the base and one field is resolved on top of it. Returning `local` whole
  // handed back every OTHER field as this device last saw it — a theme, a locale or a role
  // changed elsewhere while the toggle sat in the offline queue would be reverted by a mutator
  // that is about a subscription. A conflict resolver owns the field it is for, not the row.
  conflict: custom<MemberView>((local, server) => ({
    ...server,
    digestOptIn: server.digestOptIn ? local.digestOptIn : false,
  })),
});
