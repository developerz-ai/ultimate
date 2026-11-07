// `warmAvatar`, the orgs slice's job — one primitive per file, the layout `x g` writes.
//
// An avatar renders at a handful of sizes, and the first request for each would otherwise decode
// the upload on the request path (`/media?w=`). This job pays that once, after the upload lands,
// under the exact keys `/media` looks up — so every later render is a disk read.

import { job, t } from '@ultimat3/jobs';
import { disk, isWithinOrg, warmVariants } from '@ultimat3/storage';
import { AvatarKeyOutsideOrg } from '../errors';

/** The widths an avatar is drawn at: the 48px list row and the 96px profile, each at 1x and 2x. */
export const AVATAR_WIDTHS: readonly number[] = [48, 96, 192];

export const warmAvatar = job({
  /** The key the upload landed at, and the org it must be inside — the job checks, never trusts. */
  input: t.object({ orgId: t.uuid, key: t.string }),
  idempotencyKey: ({ key }) => `avatars.warm:${key}`,
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, step }) {
    if (!isWithinOrg(input.key, input.orgId)) throw new AvatarKeyOutsideOrg(input.key);
    // `webp` and the source's own encoding: `?w=` alone keeps the upload's format.
    const warmed = await step.run('warm', () =>
      warmVariants({ disk: disk(), key: input.key, widths: AVATAR_WIDTHS, formats: ['webp'] }),
    );
    return { written: warmed.written.length, failed: warmed.failed.map((one) => one.code) };
  },
});
