// The page's closing landmark: what this deployment is, where else to go, and the disclaimer that
// keeps a seeded demo from reading as a real network.

import { t } from '@ultimat3/i18n';
import { Icon } from '@ultimat3/ui';
import { iconAtSign } from '@ultimat3/ui/icons/at-sign';
import type { JSX } from 'solid-js';
import { footerLinksFor } from './nav';
import styles from './site-footer.module.scss';

export interface SiteFooterProps {
  readonly signedIn: boolean;
}

export function SiteFooter(props: SiteFooterProps): JSX.Element {
  return (
    <footer class={styles.footer}>
      <div class={styles.inner}>
        <div class={styles.about}>
          <span class={styles.brand}>
            <span class={styles.mark} aria-hidden="true">
              <Icon glyph={iconAtSign} />
            </span>
            {t('brand.name')}
          </span>
          <p class={styles.blurb}>{t('footer.blurb')}</p>
        </div>

        <nav class={styles.links} aria-label={t('footer.linksLabel')}>
          <p class={styles.heading}>{t('footer.explore')}</p>
          <ul class={styles.list}>
            {footerLinksFor(props.signedIn).map((link) => (
              <li>
                <a class={styles.link} href={link.href}>
                  {t(`footer.link.${link.name}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <p class={styles.disclaimer}>{t('footer.seeded')}</p>
    </footer>
  );
}
