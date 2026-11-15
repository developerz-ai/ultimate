// The two pages `x g invite` writes: the inviter's (invite an address, withdraw one) and the
// invitee's, where the mailed link lands and its org and token are posted back at `acceptInvite`.
// Native forms only: nothing hydrates, so each page ships 0 bytes of script.

import { sortedImports } from './imports';
import { catalogImport, translatorBinding } from './sign-in-shared';

export type InvitePage = 'manage' | 'accept';

const KEY: Readonly<Record<InvitePage, string>> = {
  manage: 'app.auth.invites',
  accept: 'app.auth.inviteAccept',
};

const URL_PATH: Readonly<Record<InvitePage, string>> = {
  manage: '/auth/invites',
  accept: '/auth/invites/accept',
};

const routeConfig = (key: string): string => `export const config = defineRoute({
  render: 'stream',
  hydrate: 'never',
  // Never from a cache: a stale form posts at a build that has moved on.
  offline: 'network-only',
  budget: { js: '0kb' },
  meta: ({ t }) => ({
    title: t('${key}.title'),
    description: t('${key}.description'),
    robots: { index: false, follow: false },
  }),
});`;

const MANAGE_BODY = `      <form method="post" action={derivePath('inviteMember').path}>
        <Field label={t('app.auth.invites.email')} required>
          {(control) => <Input {...control} name="email" type="email" autocomplete="off" />}
        </Field>
        <Button type="submit">{t('app.auth.invites.submit')}</Button>
      </form>
      <form method="post" action={derivePath('revokeInvite').path}>
        <Field label={t('app.auth.invites.revokeEmail')} required>
          {(control) => <Input {...control} name="email" type="email" autocomplete="off" />}
        </Field>
        <Button type="submit" variant="secondary">
          {t('app.auth.invites.revoke')}
        </Button>
      </form>`;

const ACCEPT_BODY = `      <p>{t('app.auth.inviteAccept.explain')}</p>
      <form method="post" action={derivePath('acceptInvite').path}>
        <input type="hidden" name="orgId" value={props.query?.orgId ?? ''} />
        <input type="hidden" name="token" value={props.query?.token ?? ''} />
        <Button type="submit">{t('app.auth.inviteAccept.submit')}</Button>
      </form>`;

const COMMENT: Readonly<Record<InvitePage, string>> = {
  manage: `// Invite a person into your org, or withdraw an invite: two native forms at the routes
// \`inviteMember\` and \`revokeInvite\` derive. Both refuse an actor without \`member:invite\`.`,
  accept: `// Where the mailed invite lands: its org and token, posted back at \`acceptInvite\` by a signed-in
// account. Only the account at the invited address can redeem it.`,
};

export const invitePageSource = (module: string | undefined, page: InvitePage): string => {
  const accept = page === 'accept';
  return `${COMMENT[page]}
${sortedImports([
  catalogImport(module),
  "import { derivePath } from '@ultimat3/action';",
  "import { defineRoute } from '@ultimat3/render';",
  accept
    ? "import { Button } from '@ultimat3/ui';"
    : "import { Button, Field, Input } from '@ultimat3/ui';",
])}
import styles from '${accept ? '../page.module.scss' : './page.module.scss'}';

${routeConfig(KEY[page])}
${
  accept
    ? `
export interface InviteAcceptProps {
  readonly query?: Readonly<Record<string, string>> | undefined;
}
`
    : ''
}
export function Page(${accept ? 'props: InviteAcceptProps' : ''}) {${translatorBinding(module)}
  return (
    <main class={styles.page}>
      <h1>{t('${KEY[page]}.title')}</h1>
${accept ? ACCEPT_BODY : MANAGE_BODY}
    </main>
  );
}
`;
};

/** The render line as Biome prints it: one line when it fits in 100 columns, else wrapped. */
const renderCall = (url: string): string => {
  const inline = `  const view = await renderRoute(page, { url: 'https://example.test${url}', params: {} });`;
  return inline.length <= 100
    ? inline
    : `  const view = await renderRoute(page, {\n    url: 'https://example.test${url}',\n    params: {},\n  });`;
};

const POSTS_AT = (action: string): string => `\`action="\${derivePath('${action}').path}"\``;

/** The page renders, names itself, ships no island, and posts at its actions. */
export const invitePageTest = (module: string | undefined, page: InvitePage): string => {
  const actions = page === 'accept' ? ['acceptInvite'] : ['inviteMember', 'revokeInvite'];
  const url =
    page === 'accept' ? `${URL_PATH[page]}?orgId=org-1&token=a-token` : `${URL_PATH[page]}`;
  return `// The page renders its forms at the routes they post to, with no script and no search listing.
${sortedImports([
  catalogImport(module),
  "import { derivePath } from '@ultimat3/action';",
  "import { expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
import * as page from './page';

unitTest('the page renders its forms, names itself, and ships no island', async () => {${translatorBinding(module)}
${renderCall(url)}
${actions.map((action) => `  expect(view.html).toContain(${POSTS_AT(action)});`).join('\n')}
  expect(view.meta.title).toBe(t('${KEY[page]}.title'));
  expect(view.islands).toEqual([]);
  expect(page.config.budget.js).toBe('0kb');
});
`;
};

/** Every key both pages and the invite mail read. */
export const INVITE_CATALOG: Readonly<Record<string, string>> = {
  'app.auth.invites.title': 'Invite people',
  'app.auth.invites.description': 'Invite a person into your organisation.',
  'app.auth.invites.email': 'Email',
  'app.auth.invites.submit': 'Send invite',
  'app.auth.invites.revokeEmail': 'Email to remove',
  'app.auth.invites.revoke': 'Withdraw invite',
  'app.auth.inviteAccept.title': 'Join',
  'app.auth.inviteAccept.description': 'Accept an invitation to an organisation.',
  'app.auth.inviteAccept.explain': 'Sign in as the address the invite was sent to, then accept.',
  'app.auth.inviteAccept.submit': 'Accept invite',
  'app.auth.inviteMail.subject': 'You are invited',
  'app.auth.inviteMail.body': 'You have been invited to join an organisation.',
  'app.auth.inviteMail.cta': 'Accept invite',
};
