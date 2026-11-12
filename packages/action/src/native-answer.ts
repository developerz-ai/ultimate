// The answer a browser's own `<form method="post">` gets from an action declaring `native`: a 303
// to a path, the outcome left in a flash (`action-answer.ts`). Read by the HTTP projection alone —
// the same action answers `fetch`, the typed client, MCP and `.job()` exactly as it always did.

import type { UltimateRequest } from '@ultimat3/http';
import { acceptsHtml, factsOf, hostlessPath, redirect, takeRedirect } from '@ultimat3/http';
import type { AnyAction } from './action';
import type { ActionAnswerIssue } from './action-answer';
import { answerIssues, writeActionAnswer } from './action-answer';
import { defOf } from './invoke';

/** What a refusal's path is chosen from: the stable code, its status, the fields it named. */
export interface ActionRefusal {
  readonly code: string;
  readonly status: number;
  readonly issues: readonly ActionAnswerIssue[];
}

/**
 * `native:` on an action. `success` names the page a submission lands on; `refusal` the page a
 * refused one lands on — omitted, the form's own page (the same-origin `Referer`).
 */
export interface NativeAnswer<TOutput> {
  readonly success: (output: TOutput) => string;
  readonly refusal?: (refusal: ActionRefusal) => string;
}

/** The schema-erased view `AnyActionDef` holds; method syntax keeps the parameter bivariant. */
export interface AnyNativeAnswer {
  success(output: unknown): string;
  refusal?(refusal: ActionRefusal): string;
}

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/**
 * A browser's form submission — its own, or the client router's on its behalf: it asks for a
 * page (`text/html`, the sniff `@ultimat3/http`'s error page answers on) and sends a form body.
 * A `fetch` of JSON is neither, so the typed client is never answered with a redirect.
 */
export function isNativeFormPost(req: UltimateRequest): boolean {
  if (!acceptsHtml(req.raw)) return false;
  const type = (req.header('content-type') ?? '').toLowerCase();
  return FORM_TYPES.some((form) => type.startsWith(form));
}

/** Does this action declare `native`? The `manifest` step's question, without the definition. */
export function answersNatively(target: AnyAction): boolean {
  return defOf(target).native !== undefined;
}

/**
 * Where a 303 may go, or `undefined`. A target on this origin is its path, query and fragment,
 * never starting `//` (`hostlessPath`). A SCHEME-LESS target that resolves to another origin —
 * `//evil.test`, `/\evil.test`, `\\evil.test`, a leading space — is a path built from a request
 * value that a browser reads as a host: never followed. An absolute `http(s):` URL is the app's own
 * explicit choice (an OAuth client's callback) and kept as written; any other scheme is refused.
 */
function landing(to: string, here: URL): string | undefined {
  if (!URL.canParse(to, here)) return undefined;
  const resolved = new URL(to, here);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  if (resolved.origin === here.origin) {
    return `${hostlessPath(resolved.pathname)}${resolved.search}${resolved.hash}`;
  }
  return URL.canParse(to) ? to : undefined;
}

/**
 * The form's own page: the `Referer`'s path and query, on THIS host only — a header the browser
 * sent is never a place to send it elsewhere. A same-host Referer whose path reads as a host
 * (`http://dev.test//evil.test`) is refused by `landing` like any other scheme-less target.
 * `undefined` sends the refusal down the error path.
 */
function formPage(req: UltimateRequest): string | undefined {
  const referer = req.header('referer');
  if (referer === null || !URL.canParse(referer)) return undefined;
  const from = new URL(referer);
  if (from.host !== req.url.host || (from.protocol !== 'http:' && from.protocol !== 'https:')) {
    return undefined;
  }
  return landing(`${from.pathname}${from.search}`, req.url);
}

/**
 * A refusal a form can show: a 4xx. `X_UNAUTHENTICATED` alone keeps the sign-in redirect — it is
 * the one code that redirect answers — so a sign-in's own 401 (a wrong password) lands back on its
 * form with its code. A 5xx is a defect.
 */
const isRefusal = (facts: { readonly code: string; readonly status: number }): boolean =>
  facts.status >= 400 && facts.status < 500 && facts.code !== 'X_UNAUTHENTICATED';

/**
 * Run the call and answer the browser. A `setRedirect()` inside `handle` still wins for success —
 * the one per-request fact `success(output)` cannot see (a sign-in's `next`).
 */
export async function answerNatively(
  req: UltimateRequest,
  name: string,
  native: AnyNativeAnswer,
  call: () => Promise<unknown>,
): Promise<Response> {
  let output: unknown;
  try {
    output = await call();
  } catch (error) {
    const facts = factsOf(error);
    if (!isRefusal(facts)) throw error;
    // A refused handler may have asked for a redirect before it threw; it never gets it.
    takeRedirect(req.ctx);
    const issues =
      typeof error === 'object' && error !== null ? answerIssues(Reflect.get(error, 'issues')) : [];
    const chosen = native.refusal?.({ code: facts.code, status: facts.status, issues });
    const to = chosen === undefined ? formPage(req) : landing(chosen, req.url);
    if (to === undefined) throw error;
    writeActionAnswer({
      action: name,
      outcome: 'refusal',
      code: facts.code,
      issues,
      truncated: false,
    });
    return redirect(to, 303);
  }
  const asked = takeRedirect(req.ctx);
  writeActionAnswer({ action: name, outcome: 'success' });
  if (asked !== undefined) return redirect(asked.location, asked.status);
  // Committed: an unfollowable target still answers, on the form's page, else the site's root.
  return redirect(landing(native.success(output), req.url) ?? formPage(req) ?? '/', 303);
}
