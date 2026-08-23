// The page a BROWSER gets when a request fails and this process is not in dev: Rails' `404.html`,
// with the framework's own words. The dev overlay stays the dev answer — it prints the cause, the
// fix and the stack, which is exactly what a visitor may never see — so this renderer shows the
// status, the code and the request id and nothing else off the throwable.
//
// An app overrides it with a file per status; `ServerHooks.errorPage` is the seam that reads one,
// because this package cannot see a disk.
import { singleLine } from '@ultimat3/core';
import type { InterpolationVars } from '@ultimat3/i18n';
import { t } from '@ultimat3/i18n';
import { escapeHtml } from './html-render';
import { OVERLAY_STYLE } from './overlay-style';
import { html } from './response';

/**
 * Where "Built with Ultimate" goes. Two literals and not a derivation off `ERROR_DOCS_URL`: the
 * wiki page it points at is a different destination that merely shares a prefix today. They live
 * here, next to their one renderer — a second surface that wants them (a CLI banner, a scaffolded
 * footer) is what would move them to `@ultimat3/core`.
 */
export const ERROR_PAGE_LINKS = Object.freeze<Record<'repository' | 'homepage', string>>({
  repository: 'https://github.com/developerz-ai/ultimate',
  homepage: 'https://www.developerz.ai',
});

/** One key group in the framework catalog's `errors.*` namespace, which is what this page renders. */
export type ErrorPageGroup =
  | 'notFound'
  | 'forbidden'
  | 'unauthorized'
  | 'rateLimited'
  | 'serverError'
  | 'unavailable'
  | 'badRequest';

/** Where the page's one link goes. A closed set, because a fourth destination is a design change. */
export type ErrorPageAction = 'home' | 'retry' | 'signIn';

export interface ErrorPageInput {
  readonly status: number;
  readonly code: string;
  /**
   * The pathname that failed, when there IS one. Supplied to the translator so an app that
   * overrides `errors.notFound.body` can name it; the framework's own sentence deliberately does
   * not, because the same renderer writes `404.html` into a static export, where no request
   * exists and a reflected path would be a sentence with a hole in it.
   */
  readonly path?: string | undefined;
  /** `x-request-id` for this request. Absent for a page built with no request behind it. */
  readonly requestId?: string | undefined;
  /** BCP-47 tag for `<html lang>`; the copy itself comes from the ambient translator. */
  readonly locale: string;
  /** `route.meta.policy` — the only thing a 403 page can name, and it names a rule, never a row. */
  readonly permission?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
  /** `config.signInPath`, or null when the app has not declared one. */
  readonly signInPath?: string | null;
}

export interface ErrorPageCopy {
  readonly group: ErrorPageGroup;
  readonly action: ErrorPageAction;
  readonly vars: InterpolationVars;
}

/**
 * The statuses with words of their own. A `Map` and not an object literal for `statusFor`'s
 * reason one file over: the key is a number this package computed, but a table read by a value is
 * a prototype member away from answering a function.
 */
const BY_STATUS = new Map<number, { group: ErrorPageGroup; action: ErrorPageAction }>([
  [401, { group: 'unauthorized', action: 'signIn' }],
  [403, { group: 'forbidden', action: 'home' }],
  [404, { group: 'notFound', action: 'home' }],
  [429, { group: 'rateLimited', action: 'retry' }],
  [503, { group: 'unavailable', action: 'retry' }],
]);

/**
 * The variables that group's sentence needs, or `undefined` when this request cannot supply one.
 * `interpolate` renders a missing variable as `⟦permission⟧` — loud, and correct for an author,
 * but it is a bracketed token in front of a visitor — so a group that cannot be filled degrades to
 * the class below instead of shipping the hole.
 */
function varsFor(group: ErrorPageGroup, input: ErrorPageInput): InterpolationVars | undefined {
  if (group === 'notFound') return input.path === undefined ? {} : { path: singleLine(input.path) };
  if (group === 'serverError')
    return input.requestId === undefined ? undefined : { traceId: singleLine(input.requestId) };
  if (group === 'forbidden')
    return input.permission === undefined
      ? undefined
      : { permission: singleLine(input.permission) };
  if (group === 'rateLimited')
    return input.retryAfterSeconds === undefined ? undefined : { seconds: input.retryAfterSeconds };
  return {};
}

/** 4xx and 5xx each have one sentence that needs nothing, which is what a degrade falls to. */
const classPlan = (status: number): { group: ErrorPageGroup; action: ErrorPageAction } =>
  status < 500
    ? { group: 'badRequest', action: 'home' }
    : { group: 'serverError', action: 'retry' };

/**
 * Which words this status gets. Derived from the status alone — never from the code — because
 * `ERROR_STATUS` already decided what a code MEANS to a client, and a second table keyed by code
 * would be a second answer to that question.
 */
export function resolveErrorPageCopy(input: ErrorPageInput): ErrorPageCopy {
  const plan = BY_STATUS.get(input.status) ?? classPlan(input.status);
  const vars = varsFor(plan.group, input);
  if (vars !== undefined) return { ...plan, vars };
  const fallback = classPlan(input.status);
  const fallbackVars = varsFor(fallback.group, input);
  if (fallbackVars !== undefined) return { ...fallback, vars: fallbackVars };
  // The last rung, and it is a rung rather than a `?? {}` because the ladder has to END on copy
  // that needs nothing: one group in this table asks for no variable, and landing anywhere else
  // ships `⟦traceId⟧` to a visitor.
  return { group: 'badRequest', action: 'home', vars: {} };
}

const hrefFor = (copy: ErrorPageCopy, input: ErrorPageInput): string => {
  if (copy.action === 'signIn' && input.signInPath !== null && input.signInPath !== undefined)
    return input.signInPath;
  // A retry has to be the page the visitor was on; with no request behind the page there is no
  // such address, so it degrades to the one link that is always right.
  return (copy.action === 'retry' ? input.path : undefined) ?? '/';
};

const link = (href: string, label: string): string =>
  `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

/**
 * The framework's page. One document, every status — the words are a catalog lookup and the shape
 * never changes, so an app that wants a different shape ships its own file rather than configuring
 * this one into something else.
 *
 * The key is built from the group, which is what makes `errors.*` one namespace with one reader
 * instead of seven call sites that can each drift from the table above.
 */
export function renderErrorPage(input: ErrorPageInput): string {
  const copy = resolveErrorPageCopy(input);
  const title = t(`errors.${copy.group}.title`);
  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(`${String(input.status)} ${title}`)}</title>
<style>${OVERLAY_STYLE}</style>
</head>
<body>
<main>
  <section class="card">
    <p class="status">${escapeHtml(String(input.status))}</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(t(`errors.${copy.group}.body`, copy.vars))}</p>
    <p>${link(hrefFor(copy, input), t(`errors.${copy.group}.action`))}</p>
    <dl>
      <dt>code</dt><dd>${escapeHtml(singleLine(input.code))}</dd>${
        input.requestId === undefined
          ? ''
          : `
      <dt>request</dt><dd>${escapeHtml(singleLine(input.requestId))}</dd>`
      }
    </dl>
  </section>
  <footer class="card">
    ${link(ERROR_PAGE_LINKS.repository, t('errors.page.builtWith'))}
    ${link(ERROR_PAGE_LINKS.homepage, 'developerz.ai')}
  </footer>
</main>
</body>
</html>`;
}

export interface ErrorPageOptions {
  /** The app's own file for this status, if it has one. */
  readonly override?: string | undefined;
  /** Headers the refusal computed — `retry-after` today, and nothing else so far. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The answer itself. `override` is the app's own file, served BYTE FOR BYTE — a framework that
 * interpolated a `{{status}}` into it would be a second template language, and a page an app
 * cannot predict is not an override.
 *
 * `no-store`, always: an error page filed by a shared cache under the URL that failed is served to
 * the next visitor after the incident is over. `retry-after` rides along for the same reason it
 * rides on the problem document — a 503 that does not say when to come back comes back at once.
 */
export const errorPageResponse = (
  input: ErrorPageInput,
  options: ErrorPageOptions = {},
): Response =>
  html(options.override ?? renderErrorPage(input), {
    status: input.status,
    headers: { 'cache-control': 'no-store', ...options.headers },
  });
