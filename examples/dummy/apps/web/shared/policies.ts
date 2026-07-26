/**
 * Policies both surfaces evaluate. `site/` is anonymous, which is a policy decision — not the
 * absence of one. Writing it down means the public blog cannot accidentally serve a draft.
 */

import { definePolicy } from '@ultimat3/policy';

/**
 * The only rule the static surface needs: a post is public once it is published. Evaluated at
 * prerender time and again on every ISR regeneration, so unpublishing removes the page.
 */
export const publicPostRead = definePolicy('post:read-public', {
  deny: 'errors.policyDenied',
  anonymous: true,
  check: ({ input }: { input: { status: string } }) => input.status === 'published',
});
