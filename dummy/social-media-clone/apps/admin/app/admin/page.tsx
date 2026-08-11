// The generated admin dashboard. It ships an MCP surface over the app's own actions, so the
// user's agents can drive the user's product with the user's permissions.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'spa',
  hydrate: 'idle',
  offline: 'network-only',
  // A spa renders no data, so the shell itself must be gated — @ultimat3/render requires it.
  policy: { permission: 'admin:read' },
  budget: { js: '120kb', lcp: 3000 },
  meta: () => ({ title: t('admin.home.title'), description: t('admin.home.description') }),
});

export function AdminHome() {
  return <h1>{t('admin.home.title')}</h1>;
}
