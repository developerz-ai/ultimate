// The pages `x g sign-in` writes, both shapes: the sign-in page (what proves who you are is the
// shape's — a password form or a provider link), the second-factor page, and the sign-out form.
// Native forms and links only: nothing hydrates, so each page ships 0 bytes of script.

import { sortedImports } from './imports';
import { catalogImport, SIGN_IN_PATH, translatorBinding } from './sign-in-shared';

export interface SignInTemplateOptions {
  readonly locales: readonly string[];
  /** The app's `@<app>/i18n`; absent, the page imports `t` from `@ultimat3/i18n`. */
  readonly catalogModule?: string | undefined;
}

/** What one shape puts on the sign-in page: its imports, its proof of identity, why. */
export interface SignInForm {
  readonly comment: string;
  /** Bare specifiers only, sorted with the page's own. */
  readonly imports: readonly string[];
  /** Relative imports, after the bare block. */
  readonly localImports: readonly string[];
  readonly props: boolean;
  readonly body: string;
}

const routeConfig = (key: string): string => `export const config = defineRoute({
  render: 'stream',
  hydrate: 'never',
  // Never from a cache: a stale sign-in form posts at a build that has moved on.
  offline: 'network-only',
  budget: { js: '0kb' },
  meta: ({ t }) => ({
    title: t('${key}.title'),
    description: t('${key}.description'),
    robots: { index: false, follow: false },
  }),
});`;

/** Every sign-in page carries the way out too: the one form that posts at `destroySession`. */
const SIGN_OUT_FORM = `      <form method="post" action={derivePath('destroySession').path}>
        <input type="hidden" name="confirm" value="sign-out" />
        <Button type="submit" variant="secondary">
          {t('app.auth.signOut.submit')}
        </Button>
      </form>`;

export const signInPageSource = (
  module: string | undefined,
  form: SignInForm,
): string => `${form.comment}
${sortedImports([
  catalogImport(module),
  "import { derivePath } from '@ultimat3/action';",
  "import { defineRoute } from '@ultimat3/render';",
  ...form.imports,
])}
${[...form.localImports, "import styles from './page.module.scss';"].join('\n')}

${routeConfig('app.auth.signIn')}
${
  form.props
    ? `
export interface SignInProps {
  readonly query?: Readonly<Record<string, string>> | undefined;
}
`
    : ''
}
export function Page(${form.props ? 'props: SignInProps' : ''}) {${translatorBinding(module)}
  return (
    <main class={styles.page}>
      <h1>{t('app.auth.signIn.title')}</h1>
${form.body}
${SIGN_OUT_FORM}
    </main>
  );
}
`;

/** The second leg posts the sign-in's \`next\` back, so \`confirmSession\` lands where it was going. */
export const secondFactorSource = (
  module: string | undefined,
): string => `// The second leg of a sign-in: the code from an authenticator app, posted at \`confirmSession\`.
${sortedImports([
  catalogImport(module),
  "import { derivePath } from '@ultimat3/action';",
  "import { defineRoute } from '@ultimat3/render';",
  "import { Button, Field, Input } from '@ultimat3/ui';",
])}
import { NEXT_PARAM, nextPath } from '../../sign-in-flow';
import styles from '../page.module.scss';

${routeConfig('app.auth.secondFactor')}

export interface SecondFactorProps {
  readonly query?: Readonly<Record<string, string>> | undefined;
}

export function Page(props: SecondFactorProps) {${translatorBinding(module)}
  return (
    <main class={styles.page}>
      <h1>{t('app.auth.secondFactor.title')}</h1>
      <form method="post" action={derivePath('confirmSession').path}>
        <input type="hidden" name={NEXT_PARAM} value={nextPath(props.query?.[NEXT_PARAM])} />
        <Field label={t('app.auth.secondFactor.code')} required>
          {(control) => (
            <Input {...control} name="code" inputmode="numeric" autocomplete="one-time-code" />
          )}
        </Field>
        <Button type="submit">{t('app.auth.secondFactor.submit')}</Button>
      </form>
    </main>
  );
}
`;

/** The line that holds a page to its sign-out form. */
const SIGN_OUT_EXPECTED = `  expect(view.html).toContain(\`action="\${derivePath('destroySession').path}"\`);
`;

/** The page renders, names itself, ships no island, and its form posts where `contains` says. */
export const signInPageTest = (
  module: string | undefined,
  key: string,
  contains: string,
  signOut = true,
): string => `// The page renders its form at the route it posts to, with no script and no search listing.
${sortedImports([
  catalogImport(module),
  "import { derivePath } from '@ultimat3/action';",
  "import { expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
import * as page from './page';

unitTest('the page renders its form, names itself, and ships no island', async () => {${translatorBinding(module)}
  const view = await renderRoute(page, { url: 'https://example.test${SIGN_IN_PATH}', params: {} });
  expect(view.html).toContain(${contains});
${signOut ? SIGN_OUT_EXPECTED : ''}  expect(view.meta.title).toBe(t('${key}.title'));
  expect(view.islands).toEqual([]);
  expect(page.config.budget.js).toBe('0kb');
});
`;

/** The keys every sign-in page reads; a shape adds its own. */
export const SIGN_IN_CATALOG: Readonly<Record<string, string>> = {
  'app.auth.signIn.title': 'Sign in',
  'app.auth.signIn.description': 'Sign in to your account.',
  'app.auth.signOut.submit': 'Sign out',
};
