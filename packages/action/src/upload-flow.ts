// Single responsibility: a direct upload as ONE declaration — a factory over `action` that returns
// the pair every upload slice wrote by hand: `request` (a presigned PUT under the actor's org and
// `pending/`) and `confirm` (`promoteAttachment` onto the row: measured, sniffed against `accept`,
// scanned). Never a targeted grant: the bytes reach the row's key only after they were looked at.

import type { Ctx } from '@ultimat3/core';
import { tenancyActorOrgRequired } from '@ultimat3/entity';
import type { Infer } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { StorageDriver, StorageObject, UploadPolicy } from '@ultimat3/storage';
import {
  disk as defaultDisk,
  grantUpload,
  isStorageError,
  promoteAttachment,
  uploadPolicy,
} from '@ultimat3/storage';
import type { Action } from './action';
import { action } from './action';
import type { ActionPolicy } from './policy-gate';

/** The row a confirmed upload belongs to; the flow's `name` is the field segment. */
export interface UploadFlowTarget {
  readonly entity: string;
  readonly id: string;
}

/**
 * `TRule` is the row shape the policy reads, `TRow` what `target` returns: each inferred from its
 * own option, and `TRow` must carry everything `TRule` names — else the `target` is the error.
 */
export interface UploadFlowOptions<
  TRule = unknown,
  TRow extends UploadFlowTarget & TRule = UploadFlowTarget & TRule,
> {
  /** The field the file belongs to: the key is `org/<org>/<entity>/<id>/<name>/<opaque>`. */
  readonly name: string;
  /**
   * The row, from the context and the `id` the call named (absent when it named none). It is BOTH
   * halves' `row:` loader: `policy` decides about what this returns — carry the columns the rule
   * reads (an `authorId`) — and `confirm` lands the bytes on that same row. Loaded once per call.
   */
  readonly target: (args: {
    readonly ctx: Ctx;
    readonly id: string | undefined;
  }) => TRow | Promise<TRow>;
  /** The content types the grant signs and `confirm` holds the stored bytes to. */
  readonly accept: readonly string[];
  readonly maxBytes: number;
  /**
   * One rule for both halves, judged against `target`'s row: whoever may not attach to THIS row
   * may not upload for it either. A rule over the permission alone lets any holder attach to any
   * row an `id` names.
   */
  readonly policy: ActionPolicy<TRule>;
  /** Absent: the app's default disk, resolved per call. */
  readonly disk?: (() => StorageDriver) | undefined;
  /**
   * Write `object.key` to the row here. Runs on EVERY successful confirm — a retry of one whose
   * bytes already moved runs it again with the same key — until one succeeds, so it must be
   * idempotent (a plain `update … set cover = key` is).
   */
  readonly attached?:
    | ((args: {
        readonly ctx: Ctx;
        readonly target: TRow;
        readonly object: StorageObject;
      }) => void | Promise<void>)
    | undefined;
}

const requestInput = t.object({
  /** Used for its extension and nothing else — the stored name is opaque. */
  filename: t.string.max(255),
  contentType: t.string.max(255),
  /** The file's size: the URL holds the upload to it, at the disk. */
  size: t.number.int().min(1),
  id: t.string.max(255).optional(),
});

const grantOutput = t.object({
  key: t.string,
  url: t.string,
  method: t.enumerated('PUT'),
  contentType: t.string,
  maxBytes: t.number.int(),
  /** Epoch ms. The grant's view of the window; the signature is what enforces it. */
  expiresAt: t.number.int(),
});

const confirmInput = t.object({
  /** The `pending/` key `request` answered. Anything else is refused by storage. */
  key: t.string.max(1024),
  id: t.string.max(255).optional(),
});

const attachedOutput = t.object({ key: t.string, contentType: t.string, size: t.number.int() });

export type UploadFlowGrant = Infer<typeof grantOutput>;
export type UploadFlowAttached = Infer<typeof attachedOutput>;

/** The pair, each exported by the app under its own name: `export const { request: … } = …`. */
export interface UploadFlow {
  readonly request: Action<typeof requestInput, typeof grantOutput>;
  readonly confirm: Action<typeof confirmInput, typeof attachedOutput>;
}

/** The actor's tenant: an org read off the request is the bypass `grantUpload` exists to stop. */
function orgOf(ctx: Ctx, name: string, operation: string): string {
  const orgId = ctx.actor.orgId;
  if (orgId !== undefined) return orgId;
  throw tenancyActorOrgRequired({
    entityName: `uploadFlow(${name})`,
    operation,
    actorId: ctx.actor.id,
    actorKind: ctx.actor.kind,
  });
}

const answer = (object: StorageObject): UploadFlowAttached => ({
  key: object.key,
  contentType: object.contentType,
  size: object.size,
});

/**
 * A retried confirm whose first call moved the bytes is told where they are
 * (`X_STORAGE_ALREADY_PROMOTED`, `meta.attachedKey`) and answers that object, `attached` run
 * again: the first call may have moved the bytes and then failed to write the row. Gone since (a
 * later upload replaced it): the refusal stands.
 */
async function promotedBefore(
  error: unknown,
  disk: StorageDriver,
): Promise<StorageObject | undefined> {
  if (!isStorageError(error) || error.code !== 'X_STORAGE_ALREADY_PROMOTED') return undefined;
  const attachedKey = error.meta?.['attachedKey'];
  return typeof attachedKey === 'string' ? disk.stat(attachedKey) : undefined;
}

export function uploadFlow<TRow extends UploadFlowTarget & TRule, TRule = unknown>(
  options: UploadFlowOptions<TRule, TRow>,
): UploadFlow {
  const policy: UploadPolicy = uploadPolicy({
    maxBytes: options.maxBytes,
    allowedContentTypes: options.accept,
  });
  const diskOf = options.disk ?? (() => defaultDisk());
  // The row the rule judged, handed to `handle`: `invoke` passes ONE input object to `row` and
  // `handle` by reference (#702), so it keys the load without a second one.
  const judged = new WeakMap<object, TRow>();
  const row = async ({
    input,
    ctx,
  }: {
    readonly input: { readonly id?: string | undefined };
    readonly ctx: Ctx;
  }) => {
    const loaded = await options.target({ ctx, id: input.id });
    judged.set(input, loaded);
    return loaded;
  };
  const rowOf = (input: { readonly id?: string | undefined }, ctx: Ctx): TRow | Promise<TRow> =>
    judged.get(input) ?? options.target({ ctx, id: input.id });

  const request = action({
    input: requestInput,
    output: grantOutput,
    policy: options.policy,
    row,
    async handle({ input, ctx }) {
      const orgId = orgOf(ctx, options.name, 'request');
      const { filename, contentType, size } = input;
      return grantUpload({
        disk: diskOf(),
        orgId,
        request: { filename, contentType, size },
        policy,
        clock: ctx.clock,
      });
    },
  });

  const confirm = action({
    input: confirmInput,
    output: attachedOutput,
    policy: options.policy,
    row,
    async handle({ input, ctx }) {
      const orgId = orgOf(ctx, options.name, 'confirm');
      const loaded = await rowOf(input, ctx);
      const target = { entity: loaded.entity, id: loaded.id, field: options.name };
      const disk = diskOf();
      let object: StorageObject;
      try {
        object = await promoteAttachment({ disk, key: input.key, orgId, target, policy });
      } catch (error) {
        const earlier = await promotedBefore(error, disk);
        if (earlier === undefined) throw error;
        object = earlier;
      }
      await options.attached?.({ ctx, target: loaded, object });
      return answer(object);
    },
  });

  return { request, confirm };
}
