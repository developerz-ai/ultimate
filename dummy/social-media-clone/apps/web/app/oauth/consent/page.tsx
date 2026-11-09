// Connect an MCP client to your account. The page an MCP client's authorization URL opens: it
// names the client and what it will be able to do, and the person answers with one of two native
// forms. Nothing hydrates — the decision is two POSTs at `approveConnection` / `denyConnection`,
// which re-read the request rather than trusting anything this page rendered.

import { setRedirect } from '@ultimat3/http';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { Button } from '@ultimat3/ui';
import { AppShell } from '../../../shared/ui/app-shell';
import { PageHeading } from '../../../shared/ui/page-heading';
import { callerKey, hostOf, isMetadataClient, mayRedirectRefusal, mcpOAuth } from '../server';
import styles from './page.module.scss';

export type ConsentData =
  | {
      readonly ok: true;
      readonly client: string;
      readonly scopes: readonly string[];
      /** The authorization request, as the query the client sent — posted back, re-read there. */
      readonly request: string;
      /** Where the code goes — the redirect URI's host, which a lookalike name cannot fake. */
      readonly redirectHost: string;
      /** A metadata-document client's own host; `null` for a self-registered one. */
      readonly clientHost: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  // A consent screen from a cache is a decision about a request that no longer exists.
  offline: 'network-only',
  policy: { permission: 'oauth:consent' },
  budget: { js: '0kb' },
  load: async ({ url }): Promise<ConsentData> => {
    const query = new URL(url).searchParams;
    const read = await mcpOAuth.readRequest(url, { callerKey: callerKey() });
    if (read.ok) {
      const { client } = read.request;
      return {
        ok: true,
        client: client.name,
        scopes: read.request.scopes,
        request: query.toString(),
        redirectHost: hostOf(read.request.redirectUri),
        clientHost: isMetadataClient(client.clientId) ? hostOf(client.clientId) : null,
      };
    }
    // RFC 6749 §4.1.2.1 sends a refusal back to the client — only one whose redirect URIs its own
    // domain published (`mayRedirectRefusal`); any other is rendered here.
    if (read.redirectTo !== null && mayRedirectRefusal(query)) setRedirect(read.redirectTo);
    return { ok: false, reason: read.description };
  },
  meta: () => ({
    title: t('app.oauth.consent.title'),
    description: t('app.oauth.consent.description'),
    robots: { index: false, follow: false },
  }),
});

export interface ConsentProps {
  readonly data: ConsentData;
  readonly url?: string | undefined;
}

export function Page(props: ConsentProps) {
  const data = props.data;
  return (
    <AppShell url={props.url}>
      <div class={styles.consent}>
        <PageHeading
          title={t('app.oauth.consent.title')}
          lede={t('app.oauth.consent.description')}
        />
        {data.ok ? (
          <div class={styles.card}>
            <p>{t('app.oauth.consent.asking', { client: data.client })}</p>
            {data.clientHost === null ? null : (
              <p class={styles.note} data-client-host={data.clientHost}>
                {t('app.oauth.consent.clientHost', { host: data.clientHost })}
              </p>
            )}
            <ul class={styles.scopes}>
              {data.scopes.map((scope) => (
                <li data-scope={scope}>{t(`app.oauth.consent.scope.${scope}`)}</li>
              ))}
            </ul>
            <p class={styles.note} data-redirect-host={data.redirectHost}>
              {t('app.oauth.consent.redirectHost', { host: data.redirectHost })}
            </p>
            <p class={styles.note}>{t('app.oauth.consent.revocable')}</p>
            <div class={styles.answers}>
              <form method="post" action="/api/connections/approve">
                <input type="hidden" name="request" value={data.request} />
                <Button type="submit">{t('app.oauth.consent.approve')}</Button>
              </form>
              <form method="post" action="/api/connections/deny">
                <input type="hidden" name="request" value={data.request} />
                <Button type="submit" variant="secondary">
                  {t('app.oauth.consent.deny')}
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <div class={styles.card} data-refused="true">
            <p>{t('app.oauth.consent.refused')}</p>
            <p class={styles.note}>{data.reason}</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
