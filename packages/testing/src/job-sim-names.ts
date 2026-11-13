// The effect log's queue ids, named by ordinal: `row:posts:delete:<uuid>` → `row:posts:delete:job#1`.
// Linear in the log: the ids are read once and each key once — never every id against every key,
// which a job enqueueing 500 others made 50 s of an adopter's crash proof.

/** A queue id as the memory driver mints it (`uuidV7`): 36 of lower-case hex and dashes. */
const ID = /^[0-9a-f-]{36}$/;
/** A maximal run of the characters an id is made of: any id in a key lies inside one. */
const RUN = /[0-9a-f-]+/g;

/** The one-id-at-a-time replacement, in insertion order: the answer, and the slow way to it. */
const eachInTurn = (ordinals: ReadonlyMap<string, string>, key: string): string => {
  let out = key;
  for (const [id, ordinal] of ordinals) out = out.split(id).join(ordinal);
  return out;
};

/**
 * Names `key`'s ids by `ordinals`, as replacing each id in turn would. When every id has the
 * minted shape, a run of exactly 36 is an id or no id, and an ordinal (`job#1`) holds a `#` no run
 * crosses — so one pass over the runs is that answer. A longer run may hold an id a turn-by-turn
 * replacement would split differently: that key, and any map with another id shape, takes the turns.
 */
export function ordinalNamer(ordinals: ReadonlyMap<string, string>): (key: string) => string {
  let uniform = true;
  for (const id of ordinals.keys()) {
    if (!ID.test(id)) {
      uniform = false;
      break;
    }
  }
  if (ordinals.size === 0) return (key) => key;
  if (!uniform) return (key) => eachInTurn(ordinals, key);
  return (key) => {
    let long = false;
    const named = key.replace(RUN, (run) => {
      if (run.length > 36) long = true;
      return run.length === 36 ? (ordinals.get(run) ?? run) : run;
    });
    return long ? eachInTurn(ordinals, key) : named;
  };
}
