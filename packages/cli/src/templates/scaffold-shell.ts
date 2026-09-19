// The generated app's frame — `apps/web/shared/shell.tsx` over the catalog's `AppShell` — and the
// one island the scaffold ships, the theme toggle. Split out of `scaffold-app.ts` because that file
// is the three surfaces and this is the chrome every `app/` page sits inside. Before this the
// dashboard was an `<h1>` in a panel and the scaffold imported nothing from `@ultimat3/ui`; an app
// that starts from it now starts from a designed product, and deletes what it does not want.

import { sortedImports } from './imports';
import { upToAppRoot } from './island';
import type { GeneratedFile, NameSet } from './naming';

const SHELL_DIR = 'apps/web/shared';

/** `nav` on the shell names the destinations; `--no-example` has no `/posts` to point at. */
const navType = (example: boolean): string => (example ? "'dashboard' | 'posts'" : "'dashboard'");

const postsItem = (example: boolean): string =>
  example ? `\n            {item('posts', '/posts', t('shell.nav.posts'), iconList)}` : '';

// Plain strings for the framework lines, never template literals: the workspace-dependency scanner
// blanks a string's contents but not a nested template's, so a template here would bill the CLI
// for the imports of the app it writes.
const shell = (
  app: NameSet,
  example: boolean,
): string => `// The app's frame: brand mark, the sidebar with one link per destination, an environment pill,
// the page's own actions at the end of the bar, and a footer — composed over the catalog's
// \`AppShell\`, so the skip link, the landmarks and the phone layout are the framework's and not
// this file's. \`site/page.tsx\` does NOT use it: the landing page is a 0kb document and this is the
// signed-in product's chrome. Every page under \`app/\` does.
//
// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { tryResolveEnvironment } from '@ultimat3/core';",
  "import { AppShell, Icon, type IconGlyph, Link } from '@ultimat3/ui';",
  "import { iconHexagon } from '@ultimat3/ui/icons/hexagon';",
  "import { iconLayoutDashboard } from '@ultimat3/ui/icons/layout-dashboard';",
  ...(example ? ["import { iconList } from '@ultimat3/ui/icons/list';"] : []),
  "import type { JSX } from 'solid-js';",
])}
import styles from './shell.module.scss';

/** The routes the sidebar knows about. A page names itself so its link can carry aria-current. */
export type ShellNav = ${navType(example)};

export interface ShellProps {
  readonly nav?: ShellNav | undefined;
  /** Controls that belong to the page, rendered at the end of the header bar — a theme toggle. */
  readonly actions?: JSX.Element | undefined;
  readonly children: JSX.Element;
}

export function Shell(props: ShellProps): JSX.Element {
  const t = useT();
  // Where this build runs — a fact read from the process, never a translated word. Absent when
  // neither ULTIMATE_ENV nor NODE_ENV names one, and the pill is absent with it.
  const environment = tryResolveEnvironment();

  const item = (id: ShellNav, href: string, label: string, glyph: IconGlyph): JSX.Element => (
    <li>
      <Link
        class={styles.navLink}
        href={href}
        tone="inherit"
        underline="none"
        aria-current={props.nav === id ? 'page' : false}
      >
        <Icon glyph={glyph} size="sm" class={styles.navIcon} />
        <span>{label}</span>
      </Link>
    </li>
  );

  return (
    <div class={styles.doc}>
      <AppShell
        sidebarWidth="13.5rem"
        stickyHeader
        header={
          <div class={styles.bar}>
            <Link class={styles.brand} href="/" tone="inherit" underline="none">
              {/* The mark: one accent tile, one glyph. Decorative — the wordmark beside it is the name. */}
              <span class={styles.mark} aria-hidden="true">
                <Icon glyph={iconHexagon} size="sm" />
              </span>
              <span class={styles.wordmark}>{t('shell.brand')}</span>
            </Link>
            <div class={styles.end}>
              {environment === undefined ? null : (
                <span class={styles.env}>
                  {/* The pulse is a CSS opacity animation: alive without a byte of script. */}
                  <span class={styles.envDot} aria-hidden="true" />
                  {environment}
                </span>
              )}
              {props.actions}
            </div>
          </div>
        }
        sidebar={
          <ul class={styles.nav}>
            {item('dashboard', '/dashboard', t('shell.nav.dashboard'), iconLayoutDashboard)}${postsItem(example)}
          </ul>
        }
        footer={<span>{t('shell.footer')}</span>}
      >
        {props.children}
      </AppShell>
    </div>
  );
}
`;

const shellStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

// \`display: contents\` so the wrapper vanishes from the box tree: AppShell's own grid is the
// layout, and this div exists only to scope the rules below.
.doc {
  display: contents;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: tokens.space(4);
  inline-size: 100%;
}

.end {
  display: inline-flex;
  align-items: center;
  gap: tokens.space(3);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: tokens.space(3);
  color: tokens.role('fg-strong');

  &:hover .mark {
    background: tokens.role('accent', 0.22);
  }
}

// One accent tile. The only saturated surface in the chrome, so the eye has exactly one anchor.
.mark {
  display: inline-grid;
  place-items: center;
  inline-size: tokens.space(8);
  block-size: tokens.space(8);
  border: 1px solid tokens.role('accent', 0.35);
  border-radius: tokens.radius('md');
  background: tokens.role('accent', 0.12);
  color: tokens.role('accent');
  transition: background-color tokens.duration('fast') tokens.easing('out');
}

.wordmark {
  @include tokens.data-text;

  font-size: tokens.text('sm');
  font-weight: tokens.weight('medium');
  letter-spacing: tokens.tracking('tight');
}

.env {
  @include tokens.data-text;

  display: inline-flex;
  align-items: center;
  gap: tokens.space(2);
  padding: tokens.space(1) tokens.space(3);
  border: 1px solid tokens.role('line', 0.7);
  border-radius: tokens.radius('pill');
  color: tokens.role('fg-muted');
  font-size: tokens.text('xs');
}

.envDot {
  inline-size: tokens.space(2);
  block-size: tokens.space(2);
  border-radius: tokens.radius('full');
  background: tokens.role('success');
  animation: pulse 2.4s tokens.easing('in-out') infinite;
}

// Opacity only — the one property family the motion guard admits, and the global reduced-motion
// rule switches it off.
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.nav {
  display: flex;
  // A row on a phone — stacked links cost a fifth of the first screen — a rail from md up.
  flex-direction: row;
  gap: tokens.space(1);
  margin: 0;
  padding: 0;
  overflow-x: auto;
  list-style: none;

  @include tokens.respond-to(md) {
    flex-direction: column;
  }
}

.navLink {
  display: flex;
  align-items: center;
  gap: tokens.space(3);
  padding: tokens.space(2) tokens.space(3);
  border-radius: tokens.radius('md');
  color: tokens.role('fg-muted');
  font-size: tokens.text('sm');
  transition:
    color tokens.duration('fast') tokens.easing('out'),
    background-color tokens.duration('fast') tokens.easing('out');

  &:hover {
    color: tokens.role('fg-strong');
    background: tokens.role('surface');
  }

  &[aria-current='page'] {
    color: tokens.role('fg-strong');
    background: tokens.role('surface-raised');
    box-shadow: inset 0 0 0 1px tokens.role('line', 0.7);

    .navIcon {
      color: tokens.role('accent');
    }
  }
}

.navIcon {
  flex: none;
  color: tokens.role('fg-muted');
  transition: color tokens.duration('fast') tokens.easing('out');
}
`;

const shellTest =
  (): string => `// The frame, rendered the way a route renders it: through the framework's server JSX factory,
// with the app's own catalog registered by the import. What can go wrong is structural — the
// current page losing its \`aria-current\`, the page's actions landing outside the banner — and
// both are invisible to a typecheck.
import { h, type JsxComponent } from '@ultimat3/render';
import { renderToHtml } from '@ultimat3/render/server';
import { expect, unitTest } from '@ultimat3/testing';

// A DYNAMIC import, after the static ones above have run: importing \`@ultimat3/render\` is what
// installs the loader that compiles this app's \`.tsx\` to the framework's JSX factory, and a
// plugin only reaches modules loaded after it. Imported statically, \`shell.tsx\` is transpiled
// ahead of that install, to \`React.createElement\` against a global that does not exist — the
// route modules never meet this because \`x dev\` loads them after the framework.
//
// \`h\` is typed for the framework's own components; \`Shell\` carries Solid's JSX types. The cast
// is the seam itself — the assertions below are what check it at runtime.
const shell = (await import('./shell')).Shell as unknown as JsxComponent;

unitTest('the shell marks the current destination and keeps the page in <main>', async () => {
  const html = await renderToHtml(
    h(shell, { nav: 'dashboard', children: h('p', { 'data-role': 'page' }, 'body') }),
  );
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('href="/dashboard"');
  // Landmarks come from AppShell: one banner, one navigation, one main, one contentinfo.
  expect(html.match(/<main\\b/g)?.length).toBe(1);
  expect(html.match(/<nav\\b/g)?.length).toBe(1);
  expect(html).toMatch(/<main[^>]*>[\\s\\S]*data-role="page"[\\s\\S]*<\\/main>/);
});

unitTest('no nav marks nothing current, and the actions land in the header', async () => {
  const html = await renderToHtml(
    h(shell, {
      actions: h('button', { type: 'button', 'data-role': 'action' }, 'act'),
      children: h('p', null, 'body'),
    }),
  );
  expect(html).not.toContain('aria-current="page"');
  expect(html).toMatch(/<header[^>]*>[\\s\\S]*data-role="action"[\\s\\S]*<\\/header>/);
});
`;

const toggleIsland =
  (): string => `// The theme toggle, as the one island the scaffold ships: the only module of the dashboard a
// browser downloads. Named by SPECIFIER from the page, never by import:
//   const ThemeSwitch = island({ src: '../../shared/theme-toggle.island.tsx', props: ['locale'] });
//
// The control itself is the catalog's \`ThemeToggle\`; this file is the runtime it needs and the
// one decision the framework cannot make for it — see \`bootedEnv\` below.

import {
  browserThemeEnv,
  setSolidRuntime,
  THEME_ATTRIBUTE,
  type ThemeEnv,
  ThemeToggle,
  UiProvider,
} from '@ultimat3/ui';
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';

export interface ThemeToggleIslandProps {
  /** The request's own locale, for the control's labels. A browser has no ambient one. */
  readonly locale: string;
}

/**
 * With no stored choice the catalog's \`resolveTheme\` asks the OS — but the document already wears
 * the theme the framework's boot script stamped from \`theme.defaultMode\` (dark, in this app), so
 * a toggle that asked the OS would show one theme while the page wore another. The boot's verdict
 * is on \`<html>\` before this runs: read it once, and let a stored choice win as it does there.
 */
export const bootedEnv = (): ThemeEnv => {
  const booted = document.documentElement.getAttribute(THEME_ATTRIBUTE) === 'dark';
  return { ...browserThemeEnv(), prefersDark: () => booted };
};

/**
 * The one export the hydration runtime calls. \`setSolidRuntime\` comes FIRST and is not optional:
 * \`@ultimat3/ui\` imports types from solid-js and never a runtime, so the reactive graph a
 * component reaches is the one an entry registers. Six NAMED imports, never a namespace: a
 * namespace object keeps every export of solid-js alive in the chunk. The shell is cleared before
 * \`render\`, which APPENDS — the server's copy would otherwise stay on screen beside the live one.
 */
export function mount(el: HTMLElement, props: ThemeToggleIslandProps): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  const env = bootedEnv();
  el.textContent = '';
  render(
    () => (
      <UiProvider locale={props.locale}>
        <ThemeToggle mode="toggle" env={env} />
      </UiProvider>
    ),
    el,
  );
}
`;

const toggleStates =
  (): string => `// The states the theme toggle can be photographed in. \`x shot --island theme-toggle --json\`
// takes one picture per state per theme into \`.x/shot/island/theme-toggle/\`. PURE DATA: no JSX,
// and the one import is \`import type\` — the command has to know the list before a browser exists.

import { defineIslandStates } from '@ultimat3/testing';
import type { ThemeToggleIslandProps } from './theme-toggle.island';

export const themeToggleStates = defineIslandStates({
  island: '${SHELL_DIR}/theme-toggle.island.tsx',
  states: [
    {
      id: 'default',
      title: 'the toggle as the dashboard header renders it',
      props: { locale: 'en' } satisfies ThemeToggleIslandProps,
    },
  ],
});
`;

const toggleTest =
  (): string => `// The toggle the browser actually runs: built with the same \`buildIslands\` as \`x build\`, mounted
// against a DOM small enough to read, and clicked. What it pins is the one decision this island
// makes — the boot's verdict on \`<html>\` is what the control starts from, and a click writes the
// key the boot script reads back on the next load.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from '@ultimat3/ui';
import { bootedEnv } from './theme-toggle.island';

const APP_ROOT = join(import.meta.dir, ${upToAppRoot(SHELL_DIR)});
const ISLAND = '${SHELL_DIR}/theme-toggle.island.tsx';

/** What the island reads through \`browserThemeEnv\`: storage and the OS query, both fakes. */
const stored = new Map<string, string>();
const localStorage = {
  getItem: (key: string): string | null => stored.get(key) ?? null,
  setItem: (key: string, value: string): void => void stored.set(key, value),
  removeItem: (key: string): void => void stored.delete(key),
};
const matchMedia = (): Record<string, unknown> => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

let mounted: MountedIsland;

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: { locale: 'en' },
    shell: '<button type="button">theme</button>',
    globals: { localStorage, matchMedia },
  });
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
});

describe('the theme toggle island', () => {
  test('mount renders the catalog control over the server shell', () => {
    expect(mounted.find('button')).not.toBeNull();
    expect(mounted.code).not.toMatch(/\\bReact\\b/);
  });

  test('a click stores the opposite theme and applies it to <html>', () => {
    // No stamp on this document, so the island booted light; the click flips it. \`false\` means
    // no handler ran — an onClick that never reached the DOM looks identical to a selector typo.
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(stored.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(mounted.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });

  test('the env the island builds starts from the theme stamped on <html>', () => {
    // The fake document is still installed here, so this reads exactly what \`mount\` read.
    mounted.documentElement.setAttribute(THEME_ATTRIBUTE, 'dark');
    expect(bootedEnv().prefersDark()).toBe(true);
    mounted.documentElement.setAttribute(THEME_ATTRIBUTE, 'light');
    expect(bootedEnv().prefersDark()).toBe(false);
  });
});
`;

/** The frame and the toggle island, with the states file the gate requires beside every island. */
export function shellFiles(app: NameSet, example: boolean): readonly GeneratedFile[] {
  return [
    { path: `${SHELL_DIR}/shell.tsx`, contents: shell(app, example) },
    { path: `${SHELL_DIR}/shell.module.scss`, contents: shellStyle() },
    { path: `${SHELL_DIR}/shell.test.ts`, contents: shellTest() },
    { path: `${SHELL_DIR}/theme-toggle.island.tsx`, contents: toggleIsland() },
    { path: `${SHELL_DIR}/theme-toggle.island.states.ts`, contents: toggleStates() },
    { path: `${SHELL_DIR}/theme-toggle.island.test.ts`, contents: toggleTest() },
  ];
}
