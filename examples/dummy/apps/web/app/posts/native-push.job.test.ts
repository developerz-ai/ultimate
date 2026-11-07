/**
 * job — `commentPosted`'s native channel, from the device the author registered to the DATA-ONLY
 * push her phone receives, through the real queue and a fake APNs and FCM (`mockFetch`). What can
 * fail: that the push carries the two ids and NOTHING else — no title, no comment text, nothing a
 * lock screen or the provider could read — and that a token APNs calls dead is forgotten.
 */

import { afterEach, beforeAll, expect, jobTest, mockFetch, requestLog } from '@ultimat3/testing';
import { registerDevice } from '../settings/actions/register-device';
import { unregisterDevice } from '../settings/actions/unregister-device';
import { pushDevices } from '../settings/native-push';
import { createComment } from './actions/create-comment';

const APNS = 'https://api.push.apple.com/3/device/';
const FCM = 'https://fcm.googleapis.com/v1/projects/postly-demo/messages:send';
const IOS = 'ab'.repeat(32);
const ANDROID = `postly-android:${'z'.repeat(140)}`;

const pem = (der: ArrayBuffer): string =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`;

// What `x secrets set` would put in the environment: the team's .p8 key and the service account's.
beforeAll(async () => {
  const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  const rsa = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  );
  Bun.env['ULTIMATE_APNS_PRIVATE_KEY'] = pem(await crypto.subtle.exportKey('pkcs8', ec.privateKey));
  Bun.env['ULTIMATE_FCM_PRIVATE_KEY'] = pem(await crypto.subtle.exportKey('pkcs8', rsa.privateKey));
});

// The store is the module's own (memory under `bun test`): each test leaves it as it found it.
afterEach(async () => {
  await pushDevices.remove('ios', IOS);
  await pushDevices.remove('android', ANDROID);
});

const providers = (apns: () => Response = () => new Response(null, { status: 200 })) => {
  mockFetch(`POST ${APNS}*`, apns);
  mockFetch('POST https://oauth2.googleapis.com/token', () =>
    Response.json({ access_token: 'ya29.test', expires_in: 3_599, token_type: 'Bearer' }),
  );
  mockFetch(`POST ${FCM}`, () => Response.json({ name: 'projects/postly-demo/messages/1' }));
};

const device = (platform: 'ios' | 'android', token: string) => ({
  platform,
  token,
  locale: 'es',
  timeZone: 'Europe/Madrid',
});

jobTest(
  'a comment wakes the author’s phones with the ids alone — nothing else leaves',
  async ({ seed, actorFor, runJobs, mail, push }) => {
    const { post, ada, kenji } = await seed('dev').pick({
      post: 'post:tenancy', // Ada's
      ada: 'member:ada',
      kenji: 'member:kenji',
    });
    await registerDevice.as(actorFor(ada), device('ios', IOS));
    await registerDevice.as(actorFor(ada), device('android', ANDROID));
    providers();

    const text = 'The composite key is the part I would have forgotten.';
    const comment = await createComment.as(actorFor(kenji), {
      postId: post.id,
      orgId: post.orgId,
      body: text,
    });
    await runJobs.drain();

    // The notifier's other channels ran beside this one: her mail, and no browser subscribed.
    expect(mail.outbox()).toHaveLength(1);
    expect(push.sent()).toEqual([]);
    const ids = { postId: post.id, commentId: comment.id };
    const apns = requestLog().filter((sent) => sent.url.startsWith(APNS));
    expect(apns.map((sent) => sent.url)).toEqual([`${APNS}${IOS}`]);
    expect(apns[0]?.body).toBe(JSON.stringify({ ...ids, aps: { 'content-available': 1 } }));
    expect(apns[0]?.headers['apns-push-type']).toBe('background');
    const fcm = requestLog().filter((sent) => sent.url === FCM);
    expect(fcm[0]?.body).toBe(
      JSON.stringify({ message: { token: ANDROID, data: ids, android: { priority: 'high' } } }),
    );
    // Neither the comment, the post's title nor the commenter's name reached a push provider.
    const wire = JSON.stringify(requestLog().filter((sent) => !sent.url.startsWith('http://')));
    for (const secret of [text, post.title, kenji.name]) expect(wire).not.toContain(secret);
  },
);

jobTest(
  'a token APNs calls dead is forgotten, and the notification still settles',
  async ({ seed, actorFor, runJobs, mail, push }) => {
    const { post, ada, kenji } = await seed('dev').pick({
      post: 'post:tenancy',
      ada: 'member:ada',
      kenji: 'member:kenji',
    });
    await registerDevice.as(actorFor(ada), device('ios', IOS));
    providers(() => Response.json({ reason: 'Unregistered' }, { status: 410 }));

    await createComment.as(actorFor(kenji), {
      postId: post.id,
      orgId: post.orgId,
      body: 'Adding the migration note.',
    });
    await runJobs.drain();

    expect(await pushDevices.listFor(ada.id)).toEqual([]);
    expect(mail.outbox()).toHaveLength(1);
    expect(push.sent()).toEqual([]);
    // Signing out of a device already forgotten answers `removed: false`, never an error.
    expect(await unregisterDevice.as(actorFor(ada), { platform: 'ios', token: IOS })).toEqual({
      removed: false,
    });
  },
);
