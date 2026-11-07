// The static export's SEO files: every one `siteSeo()` answered, and no `llms.txt` under
// `seo.llms: false` — that path is then the app's, in the export as on a running web role.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
// why: a scratch output directory per test; Bun has no temp-dir primitive.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testName } from '@ultimat3/testing';
import type { SiteSeo } from './site-seo';
import { writeSiteSeo } from './site-seo-write';

const SEO: SiteSeo = {
  robots: 'User-agent: *\n',
  sitemaps: [{ path: '/sitemap.xml', xml: '<urlset/>' }],
  llms: '# Site\n',
};

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'site-seo-write-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe(testName('unit', 'writeSiteSeo'), () => {
  test('writes the sitemap, robots.txt and llms.txt, and answers their paths', async () => {
    const out = await scratch();
    expect(await writeSiteSeo(out, SEO)).toEqual(['/sitemap.xml', '/robots.txt', '/llms.txt']);
    expect(await Bun.file(join(out, 'llms.txt')).text()).toBe('# Site\n');
  });

  test('seo.llms: false writes no llms.txt and does not claim one', async () => {
    const out = await scratch();
    expect(await writeSiteSeo(out, SEO, { llms: false })).toEqual(['/sitemap.xml', '/robots.txt']);
    expect(await Bun.file(join(out, 'llms.txt')).exists()).toBe(false);
    expect(await Bun.file(join(out, 'robots.txt')).text()).toBe('User-agent: *\n');
  });
});
