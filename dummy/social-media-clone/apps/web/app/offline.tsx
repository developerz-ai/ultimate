// The offline fallback. Every app/ route with offline: 'runtime' falls back here, so a train
// tunnel shows the product's own shell instead of the browser's error page.

import { t } from '@ultimat3/i18n';
import styles from './offline.module.scss';

export function OfflineFallback() {
  return (
    <main class={styles.offline}>
      <h1>{t('app.offline.title')}</h1>
      <p>{t('app.offline.description')}</p>
    </main>
  );
}
