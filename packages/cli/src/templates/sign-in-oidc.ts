// `x g sign-in --oidc <provider>`: an OpenID Connect issuer, discovered when the first sign-in
// arrives (`discoverOAuthProvider`), its two legs (`oauthLogin`) mounted on `runtime.routes`, and
// the page that links to the first one. PKCE, the sealed handshake, the state check and the account
// link are the framework's; which IdP group means which role stays the app's (`resolveGrants`).

// The literal the generated tests pin comes from auth itself, so the scaffold cannot drift from it.
import { oauthStartPath } from '@ultimat3/auth';
import { catalogJson } from './catalog-json';
import { catalogPath } from './locales';
import type { GeneratedFile } from './naming';
import {
  SIGN_IN_CATALOG,
  type SignInForm,
  type SignInTemplateOptions,
  signInPageSource,
  signInPageTest,
} from './sign-in-pages';
import { AUTH_DIR, sharedSignInFiles } from './sign-in-shared';

/** `bigco-sso` → `BIGCO_SSO`: the prefix `discoverOAuthProvider` derives its two env keys from. */
export const oidcEnvPrefix = (provider: string): string =>
  provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The settings an OIDC sign-in cannot run without, in the order `x env example` should list. */
export const oidcSignInEnv = (provider: string): readonly string[] => {
  const prefix = oidcEnvPrefix(provider);
  return [
    `${prefix}_ISSUER`,
    `${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_SECRET`,
    'SESSION_SECRET',
    'APP_URL',
  ];
};

const oidcSource = (
  provider: string,
): string => `// Sign-in through ${provider}, an OpenID Connect issuer. Discovered on the FIRST sign-in, never at
// import: the boot scan imports this module before anything may open a socket, and an IdP that is
// down must cost a sign-in, not a deploy. A failed discovery is retried by the next request.
//
// Who a first-time user IS here — roles, org — is \`resolveGrants\` (\`oauthLogin\`'s option): omitted,
// they arrive with no roles and no org, and every \`can()\` denies them. That mapping is this app's.
import {
  type Auth,
  defineAuth,
  discoverOAuthProvider,
  hasOAuthProvider,
  OAUTH_CALLBACK_ROUTE_PATH,
  type OAuthLoginRoutes,
  oauthLogin,
  oauthStartPath,
  registerOAuthProvider,
} from '@ultimat3/auth';
import { appAuth } from './auth';
import { AFTER_SIGN_IN } from './sign-in-flow';

export const OIDC_PROVIDER = '${provider}';
export const OIDC_ISSUER_ENV = '${oidcEnvPrefix(provider)}_ISSUER';
/** Where the sign-in page sends a browser: the start leg, \`${oauthStartPath(provider)}\`. */
export const OIDC_START_PATH = oauthStartPath(OIDC_PROVIDER);
/**
 * The callback leg's mount AND the \`redirect_uri\` the issuer must have registered: one value,
 * handed to \`oauthLogin({ callbackPath })\` below and mounted by \`sign-in-routes.ts\`. The
 * framework's default; set it (e.g. \`'/auth/oauth/:provider/callback'\`) to keep a URI an IdP
 * already holds, and both move together.
 */
export const OIDC_CALLBACK_PATH: string = OAUTH_CALLBACK_ROUTE_PATH;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The app's \`Auth\` over the same adapter, naming the one provider it serves. A second instance
 * and not an edit to \`auth.ts\`: its sessions are the same rows, so \`authenticator.ts\` reads them.
 */
const signInAuth = (): Auth =>
  defineAuth({ adapter: appAuth().adapter, providers: [OIDC_PROVIDER] });

let legs: Promise<OAuthLoginRoutes> | undefined;

/** The two legs, built once the issuer answered. \`sign-in-guard.ts\` refuses a deploy without it. */
export const oidcLegs = (env: Env = process.env): Promise<OAuthLoginRoutes> => {
  legs ??= (async () => {
    const issuer = (env[OIDC_ISSUER_ENV] ?? '').trim();
    if (!hasOAuthProvider(OIDC_PROVIDER)) {
      registerOAuthProvider(await discoverOAuthProvider({ id: OIDC_PROVIDER, issuer }));
    }
    return oauthLogin(signInAuth(), {
      successPath: AFTER_SIGN_IN,
      callbackPath: OIDC_CALLBACK_PATH,
    });
  })().catch((error: unknown) => {
    legs = undefined;
    throw error;
  });
  return legs;
};
`;

const oidcTest = (
  provider: string,
): string => `// The provider's names, and the one rule discovery keeps: nothing is fetched at import.
import { hasOAuthProvider } from '@ultimat3/auth';
import { expect, unitTest } from '@ultimat3/testing';
import { OIDC_ISSUER_ENV, OIDC_PROVIDER, OIDC_START_PATH, oidcLegs } from './oidc';

unitTest('the provider, its issuer key and its start path are spelled once', () => {
  expect(OIDC_PROVIDER).toBe('${provider}');
  expect(OIDC_ISSUER_ENV).toBe('${oidcEnvPrefix(provider)}_ISSUER');
  expect(OIDC_START_PATH).toBe('${oauthStartPath(provider)}');
  // Importing this module registered nothing: the first sign-in does.
  expect(hasOAuthProvider(OIDC_PROVIDER)).toBe(false);
});

unitTest('a discovery that fails is refused, and the next sign-in tries again', async () => {
  // No issuer configured: the sealed network refuses the fetch, and nothing is memoised.
  await expect(oidcLegs({})).rejects.toBeDefined();
  await expect(oidcLegs({})).rejects.toBeDefined();
  expect(hasOAuthProvider(OIDC_PROVIDER)).toBe(false);
});
`;

const routesSource =
  (): string => `// The two OIDC legs as plain HTTP routes — \`runtime.ts\` hands them to both boots. Plain routes,
// not actions: the callback is a redirect protocol whose shape the provider fixes. The callback is
// mounted at \`OIDC_CALLBACK_PATH\` — the \`callbackPath\` \`oauthLogin\` was handed, so its
// \`callback.path\` — never at a constant of its own: the mount and the \`redirect_uri\` move together.
import { OAUTH_START_ROUTE_PATH } from '@ultimat3/auth';
import type { Route } from '@ultimat3/http';
import { OIDC_CALLBACK_PATH, oidcLegs } from './oidc';

const leg = (name: 'start' | 'callback', path: string): Route => ({
  method: 'GET',
  path,
  // Public by definition: these two requests are how an anonymous visitor stops being one.
  meta: { name: \`auth.oidc.\${name}\`, auth: 'public' },
  handler: async (request) => (await oidcLegs())[name].handle(request.raw),
});

export const signInRoutes: readonly Route[] = [
  leg('start', OAUTH_START_ROUTE_PATH),
  leg('callback', OIDC_CALLBACK_PATH),
];
`;

const routesTest =
  (): string => `// Both legs are mounted, public: the start leg at the framework's path, the callback at the one
// \`oauthLogin\` is handed as \`callbackPath\` — so the mount is the \`redirect_uri\` the IdP holds.
import { OAUTH_START_ROUTE_PATH } from '@ultimat3/auth';
import { expect, unitTest } from '@ultimat3/testing';
import { OIDC_CALLBACK_PATH } from './oidc';
import { signInRoutes } from './sign-in-routes';

unitTest('the start and callback legs are public GET routes at the paths oauthLogin serves', () => {
  expect(signInRoutes.map((route) => [route.method, route.path, route.meta.auth])).toEqual([
    ['GET', OAUTH_START_ROUTE_PATH, 'public'],
    ['GET', OIDC_CALLBACK_PATH, 'public'],
  ]);
});
`;

/** A link, not a form: the start leg is a GET that redirects to the provider. */
const OIDC_FORM: SignInForm = {
  comment: `// Sign in through the identity provider: one link to the start leg, which redirects there. Nothing
// here hydrates, and no password ever reaches this app.`,
  imports: ["import { Button, Link } from '@ultimat3/ui';"],
  localImports: ["import { OIDC_START_PATH } from '../oidc';"],
  props: false,
  body: `      <Link href={OIDC_START_PATH} appearance="button">
        {t('app.auth.signIn.continue')}
      </Link>`,
};

export function oidcSignInFiles(
  provider: string,
  options: SignInTemplateOptions,
): readonly GeneratedFile[] {
  const module = options.catalogModule;
  return [
    ...sharedSignInFiles(
      oidcSignInEnv(provider),
      `The issuer and the client are ${provider}'s; SESSION_SECRET seals the handshake and APP_URL is where the provider sends the browser back.`,
      {
        importLine: "import { signInRoutes } from './app/auth/sign-in-routes';",
        expression: 'signInRoutes',
      },
    ),
    { path: `${AUTH_DIR}/oidc.ts`, contents: oidcSource(provider) },
    { path: `${AUTH_DIR}/oidc.test.ts`, contents: oidcTest(provider) },
    { path: `${AUTH_DIR}/sign-in-routes.ts`, contents: routesSource() },
    { path: `${AUTH_DIR}/sign-in-routes.test.ts`, contents: routesTest() },
    { path: `${AUTH_DIR}/sign-in/page.tsx`, contents: signInPageSource(module, OIDC_FORM) },
    {
      path: `${AUTH_DIR}/sign-in/page.test.ts`,
      contents: signInPageTest(module, 'app.auth.signIn', `'href="${oauthStartPath(provider)}"'`),
    },
    ...options.locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogJson({
        ...SIGN_IN_CATALOG,
        'app.auth.signIn.continue': `Continue with ${provider}`,
      }),
      merge: 'json' as const,
    })),
  ];
}
