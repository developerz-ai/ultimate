// `uploadFlow()` through the one authz path (`.as()`): one declaration is two registered actions,
// the grant lands under the ACTOR's org and `pending/`, and `confirm` is where the stored bytes are
// first looked at — a type the bytes contradict, or one `accept` never named, never reaches the row.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { frozenClock, isUltimateError, serviceActor, userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import type { StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver } from '@ultimat3/storage';
import { registerActions, resetActions } from './registry';
import { uploadFlow } from './upload-flow';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const TEXT = new TextEncoder().encode('just some words, not an image at all');

const ana = userActor({ id: 'ana', orgId: 'o1' });

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : `uncoded: ${String(error)}`;
  }
  return expect.unreachable('expected a coded refusal');
};

afterEach(() => {
  resetActions();
});

function flow(options: { readonly deny?: boolean } = {}) {
  const disk: StorageDriver = memoryStorageDriver({
    signingSecret: 'test-secret',
    clock: frozenClock('2026-11-12T12:00:00.000Z'),
  });
  const attached: string[] = [];
  const { request, confirm } = uploadFlow({
    name: 'cover',
    target: ({ ctx, id }) => ({ entity: 'post', id: id ?? ctx.actor.id }),
    accept: ['image/png'],
    maxBytes: 1024,
    policy: options.deny === true ? deny('test.no-uploads') : allow(),
    disk: () => disk,
    attached: ({ object }) => {
      attached.push(object.key);
    },
  });
  const registered = registerActions({ requestPostCover: request, confirmPostCover: confirm });
  return { disk, attached, request, confirm, registered };
}

const ask = (
  actor: Actor,
  request: ReturnType<typeof flow>['request'],
  contentType = 'image/png',
) => request.as(actor, { filename: 'cover.png', contentType, size: PNG.byteLength, id: 'p-1' });

describe('unit · uploadFlow', () => {
  test('one declaration registers two actions, under the names the app exported', () => {
    const { registered, request, confirm } = flow();
    expect(registered).toEqual([confirm, request]);
    expect(registered.map((one) => one.name)).toEqual(['confirmPostCover', 'requestPostCover']);
  });

  test('request grants a pending key in the actor org; confirm attaches it to the target', async () => {
    const { disk, attached, request, confirm } = flow();
    const grant = await ask(ana, request);
    expect(grant.key.startsWith('org/o1/pending/')).toBe(true);
    expect([grant.method, grant.contentType, grant.maxBytes]).toEqual(['PUT', 'image/png', 12]);
    await disk.put(grant.key, PNG, { contentType: 'image/png' });

    const object = await confirm.as(ana, { key: grant.key, id: 'p-1' });
    expect(object.key.startsWith('org/o1/post/p-1/cover/')).toBe(true);
    expect([object.contentType, object.size]).toEqual(['image/png', PNG.byteLength]);
    expect(attached).toEqual([object.key]);
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('confirm sniffs the stored bytes: a contradicted type is refused and stays pending', async () => {
    const { disk, attached, request, confirm } = flow();
    const grant = await ask(ana, request);
    // What a presigned PUT on an s3 disk cannot stop: the declared type over other bytes.
    await disk.put(grant.key, TEXT, { contentType: 'image/png' });

    expect(await codeOf(() => confirm.as(ana, { key: grant.key, id: 'p-1' }))).toBe(
      'X_STORAGE_TYPE_REJECTED',
    );
    expect(await disk.exists(grant.key)).toBe(true);
    expect(attached).toEqual([]);
  });

  test('request refuses a type accept never named, and a size over maxBytes', async () => {
    const { request } = flow();
    expect(await codeOf(() => ask(ana, request, 'text/html'))).toBe('X_STORAGE_TYPE_REJECTED');
    expect(
      await codeOf(() =>
        request.as(ana, { filename: 'a.png', contentType: 'image/png', size: 4096, id: 'p-1' }),
      ),
    ).toBe('X_STORAGE_TOO_LARGE');
  });

  test('a doubled confirm answers the object the first one attached', async () => {
    const { disk, attached, request, confirm } = flow();
    const grant = await ask(ana, request);
    await disk.put(grant.key, PNG, { contentType: 'image/png' });
    const first = await confirm.as(ana, { key: grant.key, id: 'p-1' });
    const second = await confirm.as(ana, { key: grant.key, id: 'p-1' });
    expect(second).toEqual(first);
    // The hook ran once: only the call that moved the bytes writes them to the row.
    expect(attached).toEqual([first.key]);
  });

  test('an actor with no org is refused before anything is signed', async () => {
    const { request } = flow();
    const orgless = serviceActor({ id: 'cron' });
    expect(await codeOf(() => ask(orgless, request))).toBe('X_TENANCY_ACTOR_ORG_REQUIRED');
  });

  test('the one policy guards both halves', async () => {
    const { request, confirm } = flow({ deny: true });
    expect(await codeOf(() => ask(ana, request))).toBe('X_FORBIDDEN');
    expect(await codeOf(() => confirm.as(ana, { key: 'org/o1/pending/x.png' }))).toBe(
      'X_FORBIDDEN',
    );
  });
});
