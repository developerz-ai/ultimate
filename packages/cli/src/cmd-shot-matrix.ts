// `x shot --matrix` — every static `site/` route × every locale × light and dark × a phone and a
// desktop width, into `.x/shot/matrix/`, with an `index.html` contact sheet a reviewer scrolls
// instead of opening a hundred files. One dev server for the whole run; each cell is an ordinary
// `runShot`, so a cell's `verdict.json` means exactly what a single shot's does.

// why: no Bun native joins a path.
import { join, relative } from 'node:path';
import { routeEntries } from '@ultimat3/render';
import { loadApp } from './app-load';
import type { ShotRun } from './cmd-shot';
import type { CommandResult } from './output';
import { localizedShotPath } from './shot-locale';
import type { ShotServer } from './shot-server';
import { SHOT_DIR } from './shot-server';
import type { ShotArtifacts } from './shot-verdict';

export const MATRIX_DIR = join(SHOT_DIR, 'matrix');
export const MATRIX_INDEX = 'index.html';

/** The two themes the boot honours from storage. */
export const MATRIX_THEMES: readonly ('light' | 'dark')[] = ['light', 'dark'];

/** A phone and a desktop, each with the height its class of device is photographed at. */
export const MATRIX_VIEWPORTS: readonly { readonly width: number; readonly height: number }[] = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

export interface MatrixCell {
  /** The declared route, `/precios`. */
  readonly route: string;
  readonly locale: string;
  readonly theme: 'light' | 'dark';
  readonly viewport: { readonly width: number; readonly height: number };
  /** What the browser opens: the route, prefixed for a non-default locale. */
  readonly path: string;
  /** Relative to the matrix directory: `<route-slug>/<locale>/<theme>-<width>`. */
  readonly dir: string;
}

/** A route a matrix can photograph without inventing a parameter: no `:param`, no `*rest`. */
export const isMatrixRoute = (path: string): boolean => !/[:*[]/.test(path);

const slug = (route: string): string => {
  const cleaned = route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'root' : cleaned.toLowerCase();
};

/**
 * The app's static `site/` routes, read off the registry `loadApp` fills — the same table the
 * sitemap and the static export are built from, so the matrix photographs what ships.
 */
export async function matrixRoutes(root: string): Promise<readonly string[]> {
  await loadApp(root);
  return routeEntries()
    .filter((entry) => entry.surface === 'site' && isMatrixRoute(entry.path))
    .map((entry) => entry.path);
}

export interface MatrixPlanInput {
  readonly routes: readonly string[];
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly themes?: readonly ('light' | 'dark')[] | undefined;
  readonly viewports?: readonly { readonly width: number; readonly height: number }[] | undefined;
}

/** Every cell, route-major, in a stable order — the contact sheet reads top to bottom by route. */
export function planShotMatrix(input: MatrixPlanInput): readonly MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const route of input.routes.filter(isMatrixRoute)) {
    for (const locale of input.locales) {
      for (const theme of input.themes ?? MATRIX_THEMES) {
        for (const viewport of input.viewports ?? MATRIX_VIEWPORTS) {
          cells.push({
            route,
            locale,
            theme,
            viewport,
            path: localizedShotPath(route, locale, input.defaultLocale),
            dir: join(slug(route), locale, `${theme}-${String(viewport.width)}`),
          });
        }
      }
    }
  }
  return cells;
}

export interface MatrixShot {
  readonly cell: MatrixCell;
  readonly ok: boolean;
  /** Relative to the matrix directory, as the contact sheet links it. */
  readonly image: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The contact sheet. System colours only (`Canvas`, `CanvasText`, `Mark`): a generated review page
 * has no design tokens to read, and a literal colour would be the one this repo refuses.
 */
export function contactSheet(shots: readonly MatrixShot[]): string {
  const routes = [...new Set(shots.map((shot) => shot.cell.route))];
  const sections = routes.map((route) => {
    const figures = shots
      .filter((shot) => shot.cell.route === route)
      .map((shot) => {
        const { locale, theme, viewport, path } = shot.cell;
        const label = `${locale} · ${theme} · ${String(viewport.width)}px${shot.ok ? '' : ' · FAILED'}`;
        return (
          `<figure${shot.ok ? '' : ' class="failed"'}><a href="${escapeHtml(shot.image)}">` +
          `<img src="${escapeHtml(shot.image)}" alt="${escapeHtml(`${path} ${label}`)}" loading="lazy" ` +
          `width="${String(Math.round(viewport.width / 4))}"></a>` +
          `<figcaption>${escapeHtml(label)}</figcaption></figure>`
        );
      })
      .join('');
    return `<section><h2>${escapeHtml(route)}</h2><div class="grid">${figures}</div></section>`;
  });
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>x shot --matrix</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    ':root{color-scheme:light dark}body{margin:1rem;font:14px/1.4 system-ui,sans-serif;',
    'background:Canvas;color:CanvasText}',
    '.grid{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start}',
    'figure{margin:0}img{display:block;height:auto;border:1px solid GrayText}',
    '.failed figcaption{background:Mark;color:MarkText}',
    '</style></head><body>',
    `<h1>x shot --matrix — ${String(shots.length)} pictures, ${String(shots.filter((shot) => !shot.ok).length)} failed</h1>`,
    ...sections,
    '</body></html>',
    '',
  ].join('\n');
}

export interface MatrixRun {
  readonly cells: readonly MatrixCell[];
  /** Absolute matrix directory. */
  readonly outDir: string;
  readonly boot: () => Promise<ShotServer>;
  /** `runShot`, handed in so this module never imports the command that imports it. */
  readonly shoot: (run: ShotRun) => Promise<ShotArtifacts>;
  /** Everything a cell shares: the driver, the waits, the hosts. */
  readonly base: Omit<ShotRun, 'route' | 'outDir' | 'boot' | 'colorScheme' | 'viewport'>;
}

/**
 * One server for every cell: booting `x dev` per picture would be a Postgres start per cell, and
 * reusing is the rule `devServerFor` already follows. The cells share it through a boot that
 * never stops it; the run stops it once, after the last picture.
 */
export async function runShotMatrix(run: MatrixRun): Promise<CommandResult> {
  const server = await run.boot();
  const shared: ShotServer = { ...server, stop: () => Promise.resolve() };
  const shots: MatrixShot[] = [];
  try {
    for (const cell of run.cells) {
      const artifacts = await run.shoot({
        ...run.base,
        route: cell.path,
        outDir: join(run.outDir, cell.dir),
        boot: () => Promise.resolve(shared),
        colorScheme: cell.theme,
        viewport: cell.viewport,
        acceptLanguage: cell.locale,
      });
      shots.push({
        cell,
        ok: artifacts.verdict.ok,
        image: relative(run.outDir, artifacts.image).split('\\').join('/'),
      });
    }
  } finally {
    await server.stop().catch(() => undefined);
  }
  const index = join(run.outDir, MATRIX_INDEX);
  await Bun.write(index, contactSheet(shots));
  const failed = shots.filter((shot) => !shot.ok);
  return {
    ok: failed.length === 0,
    command: 'shot',
    summary: `${String(shots.length)} pictures, ${String(failed.length)} failed — ${index}`,
    lines: failed.map((shot) => `FAILED ${shot.cell.path} (${shot.cell.dir})`),
    data: {
      index,
      cells: shots.map((shot) => ({
        route: shot.cell.route,
        path: shot.cell.path,
        locale: shot.cell.locale,
        theme: shot.cell.theme,
        width: shot.cell.viewport.width,
        image: shot.image,
        ok: shot.ok,
      })),
    },
  };
}
