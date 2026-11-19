// What `--shape saas` promises, read off its planned files: billing is app code over primitives,
// the payment receiver is the generator's own output edited (never a copy), every new table is
// tenant-scoped, and sign-in and the invite arrive through their generators.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../../cmd-new';
import { webhookReceiverFiles } from '../generate-webhook-receiver';
import type { GeneratedFile } from '../naming';
import { SHAPE_OVERLAYS } from './index';
import { BILLING_DIR } from './saas-billing';
import { RECEIVER_PATH } from './saas-receiver';

const files = planNewApp({ name: 'probe', example: true, shape: 'saas' });

const textAt = (path: string): string => {
  const file = files.find((candidate) => candidate.path === path);
  return file === undefined || typeof file.contents !== 'string' ? '' : file.contents;
};

const generated = (): readonly GeneratedFile[] =>
  webhookReceiverFiles('billing-events', { surfaceDir: 'apps/web/app', feature: 'billing' });

describe('unit · x new --shape saas', () => {
  test('billing is app files under one slice, no package and no provider SDK', () => {
    const paths = files.map((file) => file.path);
    for (const module of ['plans', 'entity', 'repo', 'entitlements', 'jobs/billing-events'])
      expect(paths).toContain(`${BILLING_DIR}/${module}.ts`);
    expect(paths.filter((path) => path.startsWith('packages/billing'))).toEqual([]);
    const manifest = textAt('package.json');
    // D9: pinned EXACT, as every other @ultimat3/* the scaffold writes — never a caret range.
    const pinned = JSON.parse(manifest).dependencies['@ultimat3/flags'];
    expect(pinned).toBe(JSON.parse(manifest).dependencies['@ultimat3/core']);
    expect(pinned).toMatch(/^\d+\.\d+\.\d+/);
    expect(
      Object.keys(JSON.parse(manifest).dependencies).filter(
        (name) => !name.startsWith('@ultimat3/') && name !== 'solid-js',
      ),
    ).toEqual([]);
  });

  test('every price is Money, and a feature is a flag keyed by plan', () => {
    const plans = textAt(`${BILLING_DIR}/plans.ts`);
    expect(plans).toContain("price: { minor: 2900, currency: 'USD' }");
    expect(plans).toContain("subjects: { plan: ['pro'] }");
    expect(plans).not.toMatch(/\d+\.\d+/);
  });

  test('the subscription table is tenant-scoped and joins the typed handle', () => {
    expect(textAt(`${BILLING_DIR}/entity.ts`)).toContain("tenant: 'orgId'");
    expect(textAt('packages/db/src/client.ts')).toContain('subscriptions: subscription,');
    expect(textAt('packages/db/src/schema.ts')).toContain('export { subscription }');
  });

  test('the receiver is the generator output, run as the org the signed event names', () => {
    const source = textAt(RECEIVER_PATH);
    const original = generated().find((file) => file.path === RECEIVER_PATH);
    // The security half is the generator's, byte for byte: verify, window, signed-bytes read.
    const verify = (text: string) =>
      text.slice(text.indexOf('function signedBytes'), text.indexOf('function readEvent'));
    expect(verify(source)).toBe(
      verify(typeof original?.contents === 'string' ? original.contents : ''),
    );
    expect(source).toContain('tenant: (event) => event.orgId,');
    expect(source).toContain('repo.applyPlan({ orgId: org,');
    expect(source).not.toContain("tenant: 'none'");
    expect(textAt('apps/web/api/index.ts')).toContain(
      '  jobs: [\n    // One entry per line: branches that each add one merge cleanly (x merge-driver).\n    reindexPost,\n    billingEvents,\n  ],',
    );
    // The exercise entry names an org: the job's tenant is read from it.
    expect(textAt('apps/web/exercise.ts')).toContain("'billing-events': {");
  });

  test('createPost draws on the plan-sized meter', () => {
    expect(textAt('apps/web/app/post/actions/create-post.ts')).toContain('meter: postMeter,');
  });

  test('sign-in and the invite are their generators, never re-spelled', () => {
    expect(SHAPE_OVERLAYS.saas.generate).toEqual([['sign-in', '--password'], ['invite']]);
    const paths = files.map((file) => file.path);
    expect(paths.filter((path) => /\/auth\/(sign-in|invites?)[/.]/.test(path))).toEqual([]);
  });

  test('nothing of the default scaffold is left out', () => {
    const base = planNewApp({ name: 'probe', example: true }).map((file) => file.path);
    const paths = new Set(files.map((file) => file.path));
    expect(base.filter((path) => !paths.has(path))).toEqual([]);
  });
});
