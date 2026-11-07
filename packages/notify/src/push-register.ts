// Single responsibility: native device registration, as two FACTORIES OVER `action` — never a ninth
// primitive and never a hand-mounted route. What they return is an action an app exports from its
// own actions module, so each one has its route, OpenAPI operation, typed client, MCP tool and
// policy like any other write:
//
//   export const registerDevice = pushRegister({ permission: 'push:subscribe', platforms, devices });
//
// The device is stored against `ctx.actor.id`, the person the request ran as — never an id the body
// names, so a caller can register only themselves and unregister only their own device.

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import { timingSafeEqual } from '@ultimat3/core';
import type { KnownPermission, PolicyArgs, PolicyDecision } from '@ultimat3/policy';
import { can, denied } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { PushDeviceRecord, PushDeviceStore, PushPlatform } from './push-device';
import { FCM_TOKEN, isDeviceToken } from './push-device';

/** Either platform's token alphabet; `platformToken` then holds each to its own. */
const anyToken = () => t.string.min(32).max(4096).pattern(FCM_TOKEN);

type Platforms = readonly [PushPlatform, ...PushPlatform[]];

const tokensMatch = (value: {
  platform: PushPlatform;
  token: string;
  previousToken?: string | undefined;
}): boolean =>
  isDeviceToken(value.platform, value.token) &&
  (value.previousToken === undefined || isDeviceToken(value.platform, value.previousToken));

const registerInput = (platforms: Platforms) =>
  t.refine(
    t.object({
      platform: t.enum(platforms),
      token: anyToken(),
      /** The token this install held before the OS rotated it — deleted as this one is stored. */
      previousToken: anyToken().optional(),
      /** BCP-47 — every visible push to this device renders in it. */
      locale: t.locale,
      /** IANA — the zone a push formatting a date would need. */
      timeZone: t.timezone,
    }),
    {
      name: 'platform-token',
      message:
        'an ios token is 64 to 200 hex characters, and an android token is an FCM registration token',
      check: tokensMatch,
      path: ['token'],
    },
  );

const deviceOutput = () => t.object({ platform: t.string, token: t.string });
const unregisterInput = (platforms: Platforms) =>
  t.object({ platform: t.enum(platforms), token: anyToken() });
const unregisterOutput = () => t.object({ removed: t.boolean });

type RegisterInput = ReturnType<typeof registerInput>;
type DeviceOutput = ReturnType<typeof deviceOutput>;
type UnregisterInput = ReturnType<typeof unregisterInput>;
type UnregisterOutput = ReturnType<typeof unregisterOutput>;

export interface PushRegisterOptions {
  /** What the registering actor must hold — read by `can()`, like every action's permission. */
  readonly permission: KnownPermission;
  /** The platforms the app ships; another is a 422. */
  readonly platforms: Platforms;
  /** The store `nativePush({ devices })` reads — the same one, handed to both. */
  readonly devices: PushDeviceStore;
  /**
   * The app's further rule, over the actor. Absent, any actor holding the permission registers
   * themselves. An AGENT never does, whatever this says: a notification is for a person's device.
   */
  readonly check?: ((args: PolicyArgs<unknown, null>) => boolean | PolicyDecision) | undefined;
}

const policyOf = (options: PushRegisterOptions) =>
  can<unknown, null>(options.permission, (args) => {
    if (args.actor?.kind === 'agent') return denied('push.agent-subscriber');
    return options.check === undefined ? true : options.check(args);
  });

/**
 * Devices one person keeps. Past it, the OLDEST registration is evicted rather than the new one
 * refused: the newest is the install most likely alive, a person whose rotated tokens were never
 * pruned keeps getting pushes on the phone they just set up, and a caller registering a pile of
 * made-up tokens costs each notification at most this many provider requests.
 */
export const PUSH_DEVICES_PER_ACTOR = 20;

/** Oldest first; `(platform, token)` breaks a tie, so both stores evict the same row. */
const byAge = (a: PushDeviceRecord, b: PushDeviceRecord): number =>
  a.createdAt - b.createdAt || (a.platform + a.token < b.platform + b.token ? -1 : 1);

/** Evict past the cap, never the row just written. Racing registers trim on the next one. */
async function capDevices(
  devices: PushDeviceStore,
  actorId: string,
  kept: { readonly platform: PushPlatform; readonly token: string },
): Promise<void> {
  const held = await devices.listFor(actorId);
  const extra = held.length - PUSH_DEVICES_PER_ACTOR;
  if (extra <= 0) return;
  const evictable = held
    .filter((device) => device.platform !== kept.platform || device.token !== kept.token)
    .sort(byAge);
  for (const device of evictable.slice(0, extra)) {
    await devices.remove(device.platform, device.token, actorId);
  }
}

/** APNs reads hex case-insensitively; one spelling keeps one row per install. */
const canonical = (platform: PushPlatform, token: string): string =>
  platform === 'ios' ? token.toLowerCase() : token;

/**
 * Store this install's token for the person signed in, and — with `previousToken` — forget the one
 * it replaces. Idempotent per token. The new row is written FIRST: a crash between the two leaves
 * both, and the old one is deleted by the provider's first "gone", never a device left with none.
 * Past `PUSH_DEVICES_PER_ACTOR` the oldest of the caller's own devices is evicted.
 */
export function pushRegister(options: PushRegisterOptions): Action<RegisterInput, DeviceOutput> {
  return action({
    input: registerInput(options.platforms),
    output: deviceOutput(),
    policy: policyOf(options),
    idempotent: true,
    async handle({ input, ctx }) {
      const token = canonical(input.platform, input.token);
      await options.devices.save({
        platform: input.platform,
        token,
        actorId: ctx.actor.id,
        locale: input.locale,
        timeZone: input.timeZone,
        createdAt: ctx.now().getTime(),
      });
      if (input.previousToken !== undefined) {
        const previous = canonical(input.platform, input.previousToken);
        // Equal is the app re-sending its current token as the previous one: deleting it would
        // drop the row just written. Neither is a secret; the helper is the one comparison.
        if (!timingSafeEqual(previous, token)) {
          await options.devices.remove(input.platform, previous, ctx.actor.id);
        }
      }
      await capDevices(options.devices, ctx.actor.id, { platform: input.platform, token });
      return { platform: input.platform, token };
    },
  });
}

/** Forget this install — the caller's own registration only; another person's is absent. */
export function pushUnregister(
  options: PushRegisterOptions,
): Action<UnregisterInput, UnregisterOutput> {
  return action({
    input: unregisterInput(options.platforms),
    output: unregisterOutput(),
    policy: policyOf(options),
    idempotent: true,
    async handle({ input, ctx }) {
      const token = canonical(input.platform, input.token);
      return { removed: await options.devices.remove(input.platform, token, ctx.actor.id) };
    },
  });
}
