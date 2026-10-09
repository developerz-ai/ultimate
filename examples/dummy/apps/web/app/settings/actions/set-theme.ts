// `setTheme`, the settings slice's mutator — one primitive per file, the layout `x g` writes.
//
// The two preference toggles that want to feel instant and survive offline — unlike the bulk
// form `savePreferences` submits, which is a deliberate "Save" click. Both route through the same
// `orgs.savePreferences` partial write that action uses, so there is exactly one place a
// preference lands in the database however it got there.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: a mutator file imports one package.

import { members, tag } from '@postly/db';
import { THEMES } from '@postly/domain';
import { mutator, t } from '@ultimat3/action';
import { memberSelf } from '../../orgs/policy';

/**
 * The local twin's row shape, keyed by the member's own id — the same id the mutator's input
 * carries, because `local()` gets no `ctx` to read the acting member off.
 */
declare module '@ultimat3/action' {
  interface LocalTables {
    member: { readonly id: string; readonly theme: string; readonly digestOptIn: boolean };
  }
}

/**
 * Both mutators answer the whole `members` row — what `orgs.savePreferences` returns — so the
 * response is a record the page store adopts, the same as `savePreferences`'s.
 */
export const setTheme = mutator({
  input: t.object({ memberId: t.uuid, theme: t.enumerated(...THEMES) }),
  output: members.$schema,
  policy: memberSelf,
  idempotent: true,
  cache: { invalidates: [tag.member] },
  mcp: { expose: true, description: 'Set the acting member’s theme' },
  local(tx, { memberId, theme }) {
    tx.member.update(memberId, () => ({ theme }));
  },
  async server(ctx, { theme }) {
    return ctx.orgs.savePreferences({ theme });
  },
  // `server-wins`, stated rather than implied. This was `last-write-wins`, which compares a
  // server-written clock — and `MemberView` carries no `updatedAt`, so it could never prove the
  // local write newer and ALWAYS answered the server row anyway. A policy that reads one way and
  // behaves another is worse than the plain one; the theme is cosmetic and the next click re-sets
  // it. Add `updatedAt` to `MemberView` first if "the device that set it last wins" is ever wanted.
  conflict: 'server-wins',
});
