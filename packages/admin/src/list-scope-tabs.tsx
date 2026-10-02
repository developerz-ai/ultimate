// Scope tabs, as links: each tab is the list's URL under that scope, with the filters and the
// sort kept. A count is drawn only on the tabs that asked for one — the page read exactly those.

import { t } from '@ultimat3/i18n';
import { Badge } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import type { AdminResource } from './resource';
import type { AdminScope } from './resource-list';

export interface AdminScopeTabsProps {
  readonly resource: AdminResource;
  /** The scope the page was read under, or `null` for the unscoped list. */
  readonly active: AdminScope | null;
  readonly counts: ReadonlyMap<string, number>;
  /** The list's URL under a scope — `null` is the unscoped list. */
  readonly hrefFor: (scope: string | null) => string;
  readonly locale: string;
}

export function AdminScopeTabs(props: AdminScopeTabsProps): JSX.Element | null {
  const scopes = props.resource.scopes;
  if (scopes.length === 0) return null;

  const tab = (name: string | null, label: string, current: boolean): JSX.Element => {
    const count = name === null ? undefined : props.counts.get(name);
    return (
      <li>
        <a
          class={styles['navLink']}
          href={props.hrefFor(name)}
          aria-current={current ? 'page' : undefined}
        >
          {label}
          {count === undefined ? null : (
            <>
              {' '}
              <Badge size="sm">{new Intl.NumberFormat(props.locale).format(count)}</Badge>
            </>
          )}
        </a>
      </li>
    );
  };

  return (
    <nav aria-label={t('admin.scope.label')}>
      <ul class={styles['scopes']}>
        {/* With no default scope the bare list is every row, and it needs a tab to return to.
            With one, "all rows" is a scope the app declares or does not offer. */}
        {scopes.some((scope) => scope.default)
          ? null
          : tab(null, t('admin.scope.all'), props.active === null)}
        {scopes.map((scope) =>
          tab(scope.name, t(scope.labelKey), props.active?.name === scope.name),
        )}
      </ul>
    </nav>
  );
}
