// What `--shape offline` promises, read off its planned files: the default app whole, the post form
// written through realtime's outbox, a replay-safe `createPost`, both offline proofs as e2e suites,
// and the LAN recipe in its README.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../../cmd-new';
import type { GeneratedFile } from '../naming';
import { FALLBACK_E2E, WRITE_E2E } from './offline-e2e';

const files = planNewApp({ name: 'probe', example: true, shape: 'offline' });

const textAt = (path: string): string => {
  const file = files.find((candidate: GeneratedFile) => candidate.path === path);
  return file === undefined || typeof file.contents !== 'string' ? '' : file.contents;
};

describe('unit · x new --shape offline', () => {
  test('keeps every file of the default app: an offline app is the default, made durable', () => {
    const paths = files.map((file) => file.path);
    const base = planNewApp({ name: 'probe', example: true }).map((file) => file.path);
    expect(base.filter((path) => !paths.includes(path))).toEqual([]);
    expect(textAt('app.config.ts')).toContain("offline: { fallback: '/offline' }");
  });

  test('the form writes through useMutation and the outbox, never a bare transport call', () => {
    const island = textAt('apps/web/app/post/post-form.island.tsx');
    expect(island).toContain(
      "import { type MutatorLike, useMutation, useOutbox } from '@ultimat3/realtime';",
    );
    expect(island).toContain("name: 'createPost' satisfies keyof Api['actions']");
    expect(island).not.toContain('clientTransport');
    expect(island).not.toContain('endpoint');
    // The import resolves: an isolated install links only what the app declares.
    expect(textAt('package.json')).toMatch(/"@ultimat3\/realtime": "\d+\.\d+\.\d+"/);
  });

  test('the page hands the form its queued label and no endpoint', () => {
    const page = textAt('apps/web/app/posts/page.tsx');
    expect(page).toContain("props: ['locale', 'currency', 'labels'],");
    expect(page).toContain("queued: t('app.post.queued'),");
    expect(page).not.toContain('derivePath');
    // The raise is measured and stated in the page, and the page's own test holds the new figure.
    expect(page).toContain("budget: { js: '156kb' },");
    expect(textAt('apps/web/app/posts/page.test.ts')).toContain("toBe('156kb');");
    expect(textAt('packages/i18n/catalogs/en.json')).toContain('"queued": ');
  });

  test('createPost is idempotent, so a replayed write answers the first result', () => {
    expect(textAt('apps/web/app/post/actions/create-post.ts')).toContain('  idempotent: true,\n');
  });

  test('both offline proofs are e2e suites, cutting the network with the driver’s offline()', () => {
    for (const path of [FALLBACK_E2E, WRITE_E2E]) {
      expect(path).toMatch(/\.e2e\.test\.ts$/);
      expect(textAt(path)).toContain('await offline();');
      expect(textAt(path)).toContain('await page.waitForServiceWorker();');
    }
    expect(textAt(FALLBACK_E2E)).toContain("toContain(t('app.offline.title'))");
    expect(textAt(WRITE_E2E)).toContain('shown: 1 });');
  });

  test('README says how to open it from a phone: a LAN address, TLS, a trusted certificate', () => {
    const readme = textAt('README.md');
    expect(readme).toContain('bunx x dev --host "$LAN_IP" --tls');
    expect(readme).toContain('.x/tls/cert.pem');
    expect(readme).toContain('## 📶 Offline');
    expect(readme).toContain('## 🗺 Layout');
    expect(readme.indexOf('## 📶 Offline')).toBeLessThan(readme.indexOf('## 🗺 Layout'));
  });
});
