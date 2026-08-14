// Mounts the /_x panels — and refuses to mount in production, because these panels print
// SQL, policy traces, and caught mail. The refusal is a throw at construction, not a 404 at
// request time: an app that boots with /_x mounted in prod has already lost.

// Type-only, so it is erased and the 46-component barrel stays out of the mount graph — the
// values arrive through the dynamic `import()` in `devShellStyle()`, same reason as `data.ts`.
import { t } from '@ultimat3/i18n';
import type { ColorRole } from '@ultimat3/ui';
import { DevDashboardInProdError } from '../errors';
import { defaultDevSources } from './data';
import type { DevSources } from './facts';
import { type DevPanel, type PanelPayload, panelPayload } from './panel';
import { cachePanel } from './panel-cache';
import { dbPanel } from './panel-db';
import { jobsPanel } from './panel-jobs';
import { livePanel } from './panel-live';
import { mailPanel } from './panel-mail';
import { manifestPanel } from './panel-manifest';
import { policyPanel } from './panel-policy';
import { routesPanel } from './panel-routes';
import { timelinePanel } from './panel-timeline';

export const DEV_PANELS: readonly DevPanel[] = [
  routesPanel,
  timelinePanel,
  livePanel,
  jobsPanel,
  dbPanel,
  mailPanel,
  cachePanel,
  policyPanel,
  manifestPanel,
];

export const DEV_BASE_PATH = '/_x';

export interface DevDashboardOptions {
  /** `ROLE` for this process. Defaults to `process.env.ROLE`. */
  readonly role?: string;
  /** `NODE_ENV` (or `X_ENV`). Defaults to the environment. */
  readonly env?: string;
  readonly basePath?: string;
  readonly sources?: DevSources;
  readonly panels?: readonly DevPanel[];
}

const envOf = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

/**
 * One rule: anything that says "production" refuses. Checked against both the framework's
 * `ROLE`-adjacent env and `NODE_ENV`, since a container may set only one of them.
 */
export function assertDevOnly(input: {
  role?: string | undefined;
  env?: string | undefined;
}): void {
  const role = input.role ?? envOf('ROLE') ?? 'dev';
  const env = input.env ?? envOf('X_ENV') ?? envOf('NODE_ENV') ?? 'development';
  if (env === 'production' || env === 'prod' || role === 'production' || role === 'prod') {
    throw new DevDashboardInProdError({ role, env });
  }
}

export interface DevDashboard {
  readonly basePath: string;
  readonly panels: readonly DevPanel[];
  /** The `--json` payload for one panel: exactly what the tab renders. */
  json(key: string, params?: URLSearchParams): Promise<PanelPayload>;
  /** `null` when the request is not ours, so a host router can fall through. */
  handle(request: Request): Promise<Response | null>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The six roles /_x paints with. `--x-*` is the admin's namespace; the values are ui's. */
const SHELL_ROLES = [
  'bg',
  'surface-raised',
  'fg',
  'fg-muted',
  'line',
  'accent',
] as const satisfies readonly ColorRole[];

const SHELL_LAYOUT = `
body { margin: 0; background: rgb(var(--x-color-bg)); color: rgb(var(--x-color-fg));
  font: 14px/1.5 ui-monospace, monospace; }
header { display: flex; gap: 1rem; padding: .75rem 1rem;
  border-bottom: 1px solid rgb(var(--x-color-line)); flex-wrap: wrap; }
a { color: rgb(var(--x-color-accent)); }
main { padding: 1rem; }
h1 { font-size: 1rem; margin: 0 1rem 0 0; }
p.question { color: rgb(var(--x-color-fg-muted)); margin: 0 0 1rem; }
pre { background: rgb(var(--x-color-surface-raised)); border: 1px solid rgb(var(--x-color-line));
  padding: 1rem; overflow: auto; }
:focus-visible { outline: 2px solid rgb(var(--x-color-accent)); outline-offset: 2px; }
`;

let stylePromise: Promise<string> | undefined;

/**
 * Tokens are inlined because /_x is a standalone page with no stylesheet pipeline — but the
 * VALUES are read from `@ultimat3/ui` rather than copied, because the copy that used to live
 * here went stale through a WCAG retune and shipped `line` on `surface-raised` at 1.16:1.
 * Reached by dynamic `import()` for the same reason `data.ts` is: /_x stays out of the
 * production graph, and the 46-component barrel loads only once a panel is actually drawn.
 *
 * Exported because the host that mounts /_x is the one that configures the CSP the panels are
 * served under, and the `style-src` hash it needs is of THIS text — a host that hashed its own
 * copy would send a policy that blocks the document this function actually writes.
 */
export async function devShellStyle(): Promise<string> {
  stylePromise ??= import('@ultimat3/ui').then(({ colorTokens }) => {
    const block = (theme: 'light' | 'dark'): string =>
      SHELL_ROLES.map((role) => `--x-color-${role}: ${colorTokens[theme][role]};`).join(' ');
    return `
:root { ${block('light')} }
@media (prefers-color-scheme: dark) { :root { ${block('dark')} } }
html[data-theme="light"] { ${block('light')} }
html[data-theme="dark"] { ${block('dark')} }
${SHELL_LAYOUT}`;
  });
  return stylePromise;
}

function shell(
  style: string,
  basePath: string,
  panels: readonly DevPanel[],
  active: DevPanel,
  payload: PanelPayload,
): string {
  const tabs = panels
    .map(
      (panel) =>
        `<a href="${basePath}/${panel.key}"${panel.key === active.key ? ' aria-current="page"' : ''}>${escapeHtml(t(panel.titleKey))}</a>`,
    )
    .join(' ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>_x · ${escapeHtml(active.key)}</title><style>${style}</style></head>
<body><header><h1>_x</h1><nav>${tabs}</nav>
<a href="${basePath}/${active.key}?json=1">--json</a></header>
<main><p class="question">${escapeHtml(t(active.questionKey))}</p>
<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></main></body></html>`;
}

/** Build the dashboard. Throws X_DEV_DASHBOARD_IN_PROD before anything else happens. */
export function devDashboard(opts: DevDashboardOptions = {}): DevDashboard {
  assertDevOnly({ role: opts.role, env: opts.env });

  const basePath = opts.basePath ?? DEV_BASE_PATH;
  const panels = opts.panels ?? DEV_PANELS;
  const sources = opts.sources ?? defaultDevSources();
  const byKey = new Map(panels.map((panel) => [panel.key, panel]));

  const json = async (key: string, params = new URLSearchParams()): Promise<PanelPayload> => {
    const panel = byKey.get(key);
    if (panel === undefined) {
      return {
        panel: key,
        ok: false,
        error: {
          code: 'X_ADMIN_ENTITY_UNKNOWN',
          cause: `no /_x panel named "${key}" (have: ${[...byKey.keys()].join(', ')})`,
          fix: `x dev --panel ${[...byKey.keys()][0] ?? 'routes'}`,
        },
      };
    }
    return panelPayload(panel, sources, params);
  };

  return {
    basePath,
    panels,
    json,

    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;

      const key = url.pathname.slice(basePath.length).replace(/^\//, '');
      const panel = byKey.get(key === '' ? (panels[0]?.key ?? '') : key);
      if (panel === undefined) return jsonResponse(await json(key, url.searchParams), 404);

      const payload = await json(panel.key, url.searchParams);
      const wantsJson =
        url.searchParams.has('json') ||
        (request.headers.get('accept') ?? '').includes('application/json');

      return wantsJson
        ? jsonResponse(payload, payload.ok ? 200 : 500)
        : new Response(shell(await devShellStyle(), basePath, panels, panel, payload), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
    },
  };
}
