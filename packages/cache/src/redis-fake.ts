// The fake `Bun.redis` both redis test files drive, and the two wire readers they assert with.
// It is a RECORDER, never an interpreter: it cannot run Lua, so it never pretends to, and every
// claim about what a script DOES lives in `redis.live.test.ts`. Not exported from `index.ts` —
// it is a test double shaped around this package's own assertions, not public API.

import type { RedisLike, RedisTierOptions } from './redis';
import { createRedisTier, REDIS_TAG_MEMBER_SCRIPT } from './redis';
import type { CacheTier } from './tiers';

export interface FakeRedis extends RedisLike {
  readonly sent: string[][];
  /**
   * What the server's script answers for one `EVAL`. A test driving a path that READS the reply
   * has to say what came back; there is no default, because `[]` is exactly what a gutted
   * `INVALIDATE_SCRIPT` returns and a silent one would make "the bust cleared nothing" the
   * baseline of both files.
   */
  answerEval(script: string, reply: unknown): void;
  /** Makes one value key's `DEL` refuse, which is the half of a bust that can fail alone. */
  refuseDel(key: string): void;
}

export function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  // The lease `EX` bought, in ms. A fake that answered no `PTTL` could not catch a tier that
  // stopped asking for one — and a hit read back without its remaining life is promoted on the
  // caller's ttl, which is how a value one second from expiry gets a fresh five minutes.
  const expiries = new Map<string, number>();
  const sent: string[][] = [];
  // A fake cannot run Lua. This one used to mirror both script bodies in TypeScript, which is why
  // gutting either to `return 1` / `return {}` left all 517 tests in `cache` + `query` green — the
  // assertions ran against the mirror and the script itself was executed by nothing, ever. What is
  // left is a recorder: the wire traffic is what those files assert, the script body is opaque to
  // them, and every claim about what a script DOES lives behind TEST_REDIS_URL.
  const evalReplies = new Map<string, unknown>([
    // Nothing reads the tag-join's reply, so a constant here asserts nothing about the script.
    [REDIS_TAG_MEMBER_SCRIPT, 1],
  ]);
  const refused = new Set<string>();
  return {
    sent,
    answerEval(script, reply) {
      evalReplies.set(script, reply);
    },
    refuseDel(key) {
      refused.add(key);
    },
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    set(key, value) {
      values.set(key, value);
      return Promise.resolve('OK');
    },
    send(command, args) {
      sent.push([command, ...args]);
      if (command === 'SET') {
        values.set(String(args[0]), String(args[1]));
        if (args[2] === 'EX') expiries.set(String(args[0]), Number(args[3]) * 1_000);
        if (args[2] === 'PX') expiries.set(String(args[0]), Number(args[3]));
        return Promise.resolve('OK');
      }
      if (command === 'PTTL') {
        const key = String(args[0]);
        if (!values.has(key)) return Promise.resolve(-2);
        return Promise.resolve(expiries.get(key) ?? -1);
      }
      if (command === 'DEL') {
        if (refused.has(String(args[0]))) {
          return Promise.reject(new Error(`redis refused DEL ${String(args[0])}`));
        }
        values.delete(String(args[0]));
        expiries.delete(String(args[0]));
        return Promise.resolve(1);
      }
      if (command === 'EVAL') {
        const script = String(args[0]);
        if (!evalReplies.has(script)) {
          // Loud rather than `[]`: an empty member list is what the gutted script answers, so a
          // default would report every bust in these files as clean and every one of them green.
          throw new Error(
            'fake redis cannot execute EVAL — call answerEval(script, reply) to state what the ' +
              'server returned, or move the claim to redis.live.test.ts, which runs the script',
          );
        }
        return Promise.resolve(evalReplies.get(script));
      }
      return Promise.resolve(null);
    },
  };
}

/**
 * `buildId: null` and `rng: () => 0` are the two things a wire assertion needs pinned: the
 * namespace carries the build id by default, and the lease is spread by default.
 */
export function tierFor(client: RedisLike, extra: RedisTierOptions = {}): CacheTier {
  return createRedisTier({ client, buildId: null, rng: () => 0, ...extra });
}

/** The `{...}` hash tag of a key, which is what Redis Cluster hashes to a slot. */
export function slotTokenOf(key: string): string {
  return /\{([^}]*)\}/.exec(key)?.[1] ?? key;
}

/**
 * Every key argument of one command — `EVAL script numkeys k1 .. kN`, `DEL key` and
 * `SREM key member..`, whose members are values rather than keys and so hash to nothing.
 */
export function keysOf(command: readonly string[]): string[] {
  if (command[0] === 'EVAL') return command.slice(3, 3 + Number(command[2]));
  if (command[0] === 'DEL') return command.slice(1);
  if (command[0] === 'SREM' || command[0] === 'SISMEMBER') return command.slice(1, 2);
  return [];
}
