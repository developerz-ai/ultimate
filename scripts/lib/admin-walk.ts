// The admin of a booted app, walked over HTTP: create a row through its own form as the role that
// may, find it in the list, edit it, delete it, and be refused as the role that may not. Pure over a `Fetcher`, so the
// walk is proved against a fake app; `scripts/scaffold-admin.ts` is what boots the real one.

import type { Finding } from './log';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AdminWalk {
  /** `http://localhost:<port>`, the name `x dev` binds — also the `Origin` a form post names. */
  readonly base: string;
  /** The resource's admin path segment: its table, `smoke_resources`. */
  readonly resource: string;
  /** The scaffold's `DEV_ROLE_COOKIE`. */
  readonly roleCookie: string;
}

export interface AdminStep {
  readonly name: string;
  readonly ok: boolean;
  /** What the app answered, when it was not what the step needs. */
  readonly got: string;
  /** The request, as a `curl` a reader can paste against a running `x dev`. */
  readonly curl: string;
}

/**
 * The create form, filled from ITS OWN fields — never a list of columns kept here, which would be a
 * second copy of the entity template and go stale the day that template gains a column.
 */
export function filledForm(
  html: string,
): { readonly action: string; readonly fields: URLSearchParams } | undefined {
  const form = /<form\b[^>]*\bmethod="post"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  const action = /\baction="([^"]+)"/.exec(form?.[0] ?? '')?.[1];
  if (form === null || action === undefined) return undefined;
  const fields = new URLSearchParams();
  for (const [tag] of (form[1] ?? '').matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    const type = /\btype="([^"]+)"/.exec(tag)?.[1] ?? 'text';
    if (name === undefined || type === 'checkbox' || type === 'hidden') continue;
    const numeric = type === 'number' || /\binputmode="(?:numeric|decimal)"/.test(tag);
    fields.set(name, name.endsWith('.currency') ? 'USD' : numeric ? '100' : 'smoke row');
  }
  return { action, fields };
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** One request as the role, and as the `curl` that repeats it. */
async function ask(
  walk: AdminWalk,
  fetcher: Fetcher,
  role: 'admin' | 'member',
  path: string,
  body?: URLSearchParams,
): Promise<{ readonly response: Response; readonly text: string; readonly curl: string }> {
  const cookie = `${walk.roleCookie}=${role}`;
  const url = `${walk.base}${path}`;
  const response = await fetcher(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      ...(body === undefined
        ? {}
        : { origin: walk.base, 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(body === undefined ? {} : { body: body.toString() }),
  });
  const write =
    body === undefined
      ? ''
      : ` -H ${quote(`origin: ${walk.base}`)} --data ${quote(body.toString())}`;
  return {
    response,
    text: await response.text(),
    curl: `curl -i -H ${quote(`cookie: ${cookie}`)}${write} ${url}`,
  };
}

/** The issues block a refused create renders, as text — what a 422 is worth reading for. */
const issuesIn = (html: string): string => {
  const block = /class="x-admin-issues"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const text = block
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? '' : ` — the form said: ${text.slice(0, 300)}`;
};

/**
 * The walk. Every step runs — a member who can write is worth knowing about even when the list is
 * broken too — except the two that need what a failed step did not produce.
 */
export async function walkAdmin(
  walk: AdminWalk,
  fetcher: Fetcher = fetch,
): Promise<readonly AdminStep[]> {
  const list = `/admin/${walk.resource}`;
  const steps: AdminStep[] = [];
  const step = (name: string, ok: boolean, got: string, curl: string): boolean => {
    steps.push({ name, ok, got: ok ? '' : got, curl });
    return ok;
  };
  const answered = (response: Response): string => `answered ${String(response.status)}`;

  const opened = await ask(walk, fetcher, 'admin', list);
  const listed = step(
    'the admin role opens the list',
    opened.response.status === 200,
    answered(opened.response),
    opened.curl,
  );

  let created: string | undefined;
  let body = new URLSearchParams({ title: 'smoke row' });
  let action = `${list}/new`;
  if (listed) {
    const formPage = await ask(walk, fetcher, 'admin', `${list}/new`);
    const form = formPage.response.status === 200 ? filledForm(formPage.text) : undefined;
    const hasForm = step(
      'the admin role opens the create form',
      form !== undefined,
      formPage.response.status === 200
        ? 'answered 200 with no <form method="post">'
        : answered(formPage.response),
      formPage.curl,
    );
    if (hasForm && form !== undefined) {
      body = form.fields;
      action = form.action;
      const posted = await ask(walk, fetcher, 'admin', action, body);
      const location = posted.response.headers.get('location') ?? '';
      created = posted.response.status === 303 ? location.split('/').at(-1) : undefined;
      step(
        'the admin role creates a row',
        created !== undefined && created !== '',
        `${answered(posted.response)}${issuesIn(posted.text)}`,
        posted.curl,
      );
      const after = await ask(walk, fetcher, 'admin', list);
      const shown = step(
        'the list shows the row',
        created !== undefined && after.text.includes(`data-row="${created}"`),
        created === undefined
          ? 'no row was created to look for'
          : `${answered(after.response)} with no data-row="${created}"`,
        after.curl,
      );
      // The other two writes, each behind its own pair of grants: `admin:write` + the table's
      // `:write` to edit, `admin:destroy` + its `:delete` to delete. A role map that grants the
      // admin role one and not the other fails HERE and nowhere earlier.
      if (shown && created !== undefined) {
        const row = `${list}/${created}`;
        const edited = await ask(walk, fetcher, 'admin', `${row}/edit`, body);
        step(
          'the admin role edits the row',
          edited.response.status === 303,
          `${answered(edited.response)}${issuesIn(edited.text)}`,
          edited.curl,
        );
        const deleted = await ask(
          walk,
          fetcher,
          'admin',
          row,
          // The typed confirmation a delete owes: `<entity>:<id>`.
          new URLSearchParams({
            _operation: 'delete',
            confirmation: `${walk.resource}:${created}`,
          }),
        );
        const gone =
          deleted.response.status === 303 ? await ask(walk, fetcher, 'admin', list) : null;
        step(
          'the admin role deletes the row',
          gone !== null && !gone.text.includes(`data-row="${created}"`),
          gone === null
            ? answered(deleted.response)
            : `answered 303 and the list still shows data-row="${created}"`,
          deleted.curl,
        );
      }
    }
  }

  const refused = await ask(walk, fetcher, 'member', list);
  step(
    'the member role is refused the list',
    refused.response.status === 403 && !refused.text.includes('data-row='),
    answered(refused.response),
    refused.curl,
  );
  const blocked = await ask(walk, fetcher, 'member', action, body);
  step(
    'the member role is refused the write',
    blocked.response.status === 403,
    answered(blocked.response),
    blocked.curl,
  );
  return steps;
}

/** One finding per failed step; its `fix:` boots the app and repeats that step's request. */
export const adminFindings = (
  dir: string,
  walk: AdminWalk,
  steps: readonly AdminStep[],
): readonly Finding[] =>
  steps
    .filter((step) => !step.ok)
    .map((step) => ({
      code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
      cause: `the scaffolded app's /admin/${walk.resource} failed "${step.name}": ${step.got}`,
      fix: `cd ${dir} && bin/dev --port ${new URL(walk.base).port || '3000'}   # then, in a second shell: ${step.curl}`,
      at: dir,
    }));
