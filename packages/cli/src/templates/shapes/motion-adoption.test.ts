// The shapes' motion, read off the planned files: the dashboard animates through `@ultimat3/ui/motion`
// (spring, stagger, enter/exit, layout), every landing sits on a css-tier backdrop with no island,
// and every symbol a generated file imports from the motion engine or `@ultimat3/effects` is one
// the package really exports — the scaffold can never advertise an API that is not shipped.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path'; // why: Bun ships no path API.
import { planNewApp } from '../../cmd-new';
import type { NewShape } from '../../new-shapes';
import type { GeneratedFile } from '../naming';

const REPO = join(import.meta.dir, '../../../../..');
const plan = (shape: NewShape): readonly GeneratedFile[] =>
  planNewApp({ name: 'probe', example: true, shape });
const at = (files: readonly GeneratedFile[], path: string): string => {
  const file = files.find((candidate) => candidate.path === path);
  return typeof file?.contents === 'string' ? file.contents : '';
};

const transpiler = new Bun.Transpiler({ loader: 'tsx' });
const exportsOf = async (path: string): Promise<ReadonlySet<string>> =>
  new Set(transpiler.scan(await Bun.file(join(REPO, path)).text()).exports);

const ISLAND = 'apps/web/app/dashboard/dashboard-motion.island.tsx';

describe('unit · shapes · motion', () => {
  test('dashboard: spring, stagger, enter/exit and layout come from @ultimat3/ui/motion', () => {
    const island = at(plan('dashboard'), ISLAND);
    expect(island).toContain("from '@ultimat3/ui/motion'");
    for (const call of ['Presence', 'stagger', 'inView', 'layout']) expect(island).toContain(call);
    expect(island).toContain("easing: 'snappy'");
    expect(island).toContain("easing: 'gentle'");
  });

  test('dashboard: the page declares the island and hands it translated strings', () => {
    const page = at(plan('dashboard'), 'apps/web/app/dashboard/page.tsx');
    expect(page).toContain("src: './dashboard-motion.island.tsx'");
    expect(page).toContain("t('app.dashboard.motionOpen')");
  });

  test('dashboard: list and detail share one view-transition name', () => {
    const files = plan('dashboard');
    expect(at(files, 'apps/web/app/posts/page.module.scss')).toContain(
      'view-transition-name(post-main)',
    );
    expect(at(files, 'apps/web/app/posts/[id]/page.module.scss')).toContain(
      'view-transition-name(post-main)',
    );
  });

  for (const shape of ['dashboard', 'saas'] as const) {
    test(`${shape}: the landing wears Aurora, declares @ultimat3/effects, stays 0kb`, () => {
      const files = plan(shape);
      expect(at(files, 'apps/web/site/page.tsx')).toContain('<Aurora class={styles.aurora} />');
      expect(at(files, 'apps/web/site/page.tsx')).toContain("budget: { js: '0kb' }");
      expect(at(files, 'package.json')).toContain('"@ultimat3/effects"');
      expect(files.some((file) => file.path === 'apps/web/site/landing-motion.test.ts')).toBe(true);
    });
  }

  test('blog and content: an Aurora behind the front page, one name across the shell', () => {
    const blog = plan('blog');
    expect(at(blog, 'apps/web/site/page.tsx')).toContain('<Aurora class={styles.aurora} />');
    expect(at(blog, 'apps/web/site/posts/[slug]/page.module.scss')).toContain(
      'view-transition-name(blog-main)',
    );
    const content = plan('content');
    expect(at(content, 'apps/web/site/page.tsx')).toContain('<Aurora class={styles.aurora} />');
    expect(at(content, 'apps/web/shared/site-frame.module.scss')).toContain(
      'view-transition-name(site-main)',
    );
    for (const files of [blog, content])
      expect(at(files, 'package.json')).toContain('"@ultimat3/effects"');
  });

  test('every motion and effects symbol a generated file imports is exported', async () => {
    const motion = await exportsOf('packages/ui/src/motion/index.ts');
    const effects = await exportsOf('packages/effects/src/index.ts');
    const pattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(@ultimat3\/(?:ui\/motion|effects))'/g;
    let checked = 0;
    for (const shape of ['dashboard', 'saas', 'blog', 'content'] as const) {
      for (const file of plan(shape)) {
        const text = typeof file.contents === 'string' ? file.contents : '';
        for (const [, names = '', from] of text.matchAll(pattern)) {
          const known = from === '@ultimat3/ui/motion' ? motion : effects;
          for (const name of names.split(',').map((part) => part.trim().replace(/^type\s+/, ''))) {
            if (name === '') continue;
            checked += 1;
            expect({
              file: file.path,
              name,
              shipped: known.has(name) || /^[A-Z]\w*Props$/.test(name) || name === 'MotionFrame',
            }).toEqual({ file: file.path, name, shipped: true });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(4);
  });
});
