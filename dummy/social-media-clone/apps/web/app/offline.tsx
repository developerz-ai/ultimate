// The offline fallback. Every app/ route with offline: 'runtime' falls back here, so a train
// tunnel shows the product's own shell instead of the browser's error page — which is the whole
// point of rendering it inside `AppShell` rather than as a bare paragraph.

import { t } from '@ultimat3/i18n';
import { iconWifiOff } from '@ultimat3/ui/icons/wifi-off';
import { AppShell } from '../shared/ui/app-shell';
import { EmptyState } from '../shared/ui/empty-state';
import styles from './offline.module.scss';

export function OfflineFallback() {
  return (
    <AppShell>
      <h1 class={styles.title}>{t('app.offline.title')}</h1>
      <EmptyState
        glyph={iconWifiOff}
        title={t('app.offline.description')}
        description={t('app.offline.help')}
      />
    </AppShell>
  );
}
