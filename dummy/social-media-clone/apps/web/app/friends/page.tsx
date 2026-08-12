// The friends screen: who asked you, who you asked, who said yes, who said no, and who you blocked.
//
// Five lists rather than one, because DIRECTION carries meaning. A single "friends" list would have
// to invent back the fact the `(requesterId, addresseeId)` key exists to keep, and the inbox is the
// only one of the five with a control on it — you cannot answer your own request.
//
// The component is `async` because a route has no `load` seam: `RouteDefinition` carries render,
// offline, hydrate, budget, meta and policy, and nothing that fetches. The renderer awaits a
// promise, so an async component works — recorded here as a workaround, not hidden.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { Stack, Text } from '@ultimat3/ui';
import { currentViewer } from '../../shared/actor';
import { AppShell } from '../../shared/ui/app-shell';
import { PageHeading } from '../../shared/ui/page-heading';
import styles from './page.module.scss';
import { friendsScreen } from './screen';
import { EdgeList } from './ui/edge-list';
import { RespondForm } from './ui/respond-form';
import { UnblockForm } from './ui/unblock-form';

export const config = defineRoute({
  render: 'ssr',
  // Nothing on this screen is interactive without a server round trip: every control is a real
  // form. So the page ships no JS, and says so in bytes rather than in a comment.
  hydrate: 'never',
  offline: 'network-only',
  // Auth is a policy, never a route-local flag: `friend:read` is the same object the actions and
  // the MCP tools are gated by.
  policy: { permission: 'friend:read' },
  budget: { js: '0kb', lcp: 2500 },
  meta: () => ({
    title: t('app.friends.title'),
    description: t('app.friends.description'),
    // Somebody's social graph is not search-engine material, whatever the gate in front of it.
    robots: { index: false, follow: false },
  }),
});

export async function Page(props: { readonly url?: string | undefined }) {
  const viewer = currentViewer();
  // Unreachable through HTTP — `friend:read` denies an anonymous caller before the render — but a
  // render is not the place to assert that. An empty screen beats a thrown TypeError.
  if (viewer === null) {
    return (
      <AppShell url={props.url} width="wide">
        <Text as="p" tone="muted">
          {t('app.friends.description')}
        </Text>
      </AppShell>
    );
  }

  const screen = await friendsScreen(viewer.id);

  return (
    <AppShell url={props.url} width="wide">
      <PageHeading
        eyebrow={t('app.friends.eyebrow')}
        title={t('app.friends.title')}
        lede={t('app.friends.description')}
      />
      <Stack gap={8} class={styles.sections}>
        <EdgeList
          title={t('app.friends.incoming.title')}
          description={t('app.friends.incoming.description')}
          empty={t('app.friends.incoming.empty')}
          items={screen.incoming}
          dateKey="app.friends.asked"
          badge={{ label: t('app.friends.status.pending'), tone: 'warning' }}
          // The ONLY list with controls. `friendRespond` loads the row by `(requester, caller)`, so
          // the rule that renders these buttons is the rule that answers the call.
          control={(item) => <RespondForm requesterId={item.person.id} />}
        />
        <EdgeList
          title={t('app.friends.outgoing.title')}
          description={t('app.friends.outgoing.description')}
          empty={t('app.friends.outgoing.empty')}
          items={screen.outgoing}
          dateKey="app.friends.asked"
          badge={{ label: t('app.friends.status.pending'), tone: 'neutral' }}
        />
        <EdgeList
          title={t('app.friends.current.title')}
          description={t('app.friends.current.description')}
          empty={t('app.friends.current.empty')}
          items={screen.friends}
          dateKey="app.friends.answered"
          badge={{ label: t('app.friends.status.accepted'), tone: 'success' }}
        />
        <EdgeList
          title={t('app.friends.declined.title')}
          description={t('app.friends.declined.description')}
          empty={t('app.friends.declined.empty')}
          items={screen.declined}
          dateKey="app.friends.answered"
          badge={{ label: t('app.friends.status.declined'), tone: 'danger' }}
        />
        <EdgeList
          title={t('app.friends.blocked.title')}
          description={t('app.friends.blocked.description')}
          empty={t('app.friends.blocked.empty')}
          items={screen.blocked}
          dateKey="app.friends.blockedOn"
          control={(item) => <UnblockForm userId={item.person.id} />}
        />
      </Stack>
    </AppShell>
  );
}
