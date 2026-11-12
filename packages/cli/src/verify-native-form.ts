// The `manifest` step's native-form rider: a page's `<form method="post">` that posts to an action
// declaring no `native` leaves a reader with scripting off staring at JSON. On `main` it is a
// WARNING naming `X_NATIVE_FORM_UNANSWERED` (a red gate on an existing app is X_BREAKING_ON_MAIN);
// the refusal lands on `next`. The form's target is read by `native-form-scan.ts`.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import type { AnyAction } from '@ultimat3/action';
import { answersNatively, listActions } from '@ultimat3/action';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { PostForm } from './native-form-scan';
import { pathMatches, postForms } from './native-form-scan';
import type { Finding } from './output';

/** Every page an app serves: the directory is the URL, the file is always `page.tsx`. */
export const PAGE_GLOB = 'apps/*/{app,site}/**/page.tsx';

/** The registered action a form posts to, if any — by name, or by the route path it answers. */
function actionFor(form: PostForm, actions: readonly AnyAction[]): AnyAction | undefined {
  if (form.target.kind === 'name') {
    const { value } = form.target;
    return actions.find((one) => one.name === value);
  }
  const { value } = form.target;
  return actions.find((one) => pathMatches(one.describe().path, value));
}

/** An unanswered form: the action it posts to, and where. */
interface UnansweredForm {
  readonly action: string;
  readonly page: string;
  readonly line: number;
}

export function nativeFormFinding(action: string, page: string, line: number): Finding {
  return {
    code: 'X_NATIVE_FORM_UNANSWERED',
    cause: `${page}:${line} posts a <form method="post"> to action "${action}", which declares no native answer — a browser submitting it lands on JSON`,
    fix: `native: { success: (output) => '/where-it-lands' }   # in action "${action}"'s declaration, then x verify --only manifest`,
    at: page,
  };
}

/** Every unanswered form, after the app loaded — a short registry is the load's finding. */
async function unansweredForms(
  root: string,
  load: AppLoader,
  actions: () => readonly AnyAction[],
): Promise<readonly UnansweredForm[]> {
  if ((await load(root)).findings.length > 0) return [];
  const registered = actions();
  const pages: string[] = [];
  for await (const page of new Bun.Glob(PAGE_GLOB).scan({ cwd: root })) {
    pages.push(page.replaceAll('\\', '/'));
  }
  const unanswered: UnansweredForm[] = [];
  for (const page of pages.sort()) {
    const source = await Bun.file(join(root, page)).text();
    for (const form of postForms(source)) {
      const target = actionFor(form, registered);
      if (target !== undefined && !answersNatively(target)) {
        unanswered.push({ action: target.name, page, line: form.line });
      }
    }
  }
  return unanswered;
}

/** The findings the refusal on `next` will report — the same facts the warnings print. */
export async function nativeFormFindings(
  root: string,
  load: AppLoader = loadApp,
  actions: () => readonly AnyAction[] = listActions,
): Promise<readonly Finding[]> {
  return (await unansweredForms(root, load, actions)).map((form) =>
    nativeFormFinding(form.action, form.page, form.line),
  );
}

/**
 * What the `manifest` step carries on `main`: one line per unanswered form — the code, the cause
 * (which opens with `page:line`) and the fix — advice in `StepOutcome.warnings`, never a failed step.
 */
export async function nativeFormWarnings(
  root: string,
  load: AppLoader = loadApp,
  actions: () => readonly AnyAction[] = listActions,
): Promise<readonly string[]> {
  return (await unansweredForms(root, load, actions)).map((form) => {
    const finding = nativeFormFinding(form.action, form.page, form.line);
    return `${finding.code} ${finding.cause} — fix: ${finding.fix}`;
  });
}
