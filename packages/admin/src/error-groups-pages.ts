// Single responsibility: `/admin/errors` as `pages:` entries — the list and one group's detail,
// guarded like every custom page (`admin:read` plus `errors:read`). Data, not a new screen kind:
// the route table, the nav and the audit of a refusal are the ones `pages.ts` already builds.

import type { ErrorGroupsStore } from './error-groups-store';
import { ErrorsDetail } from './errors-detail';
import { ErrorsList } from './errors-list';
import type { AdminCustomPage } from './pages';

/** The permission the two pages compose after `admin:read`. */
export const ERRORS_READ = 'errors:read';

export interface ErrorGroupsPagesOptions {
  readonly store: ErrorGroupsStore;
  /** The nav group the list is linked under; omitted, reachable by URL only. */
  readonly navGroup?: string | undefined;
  /** Rooted at the admin's `basePath`. Default `/errors`. */
  readonly path?: string | undefined;
}

export function errorGroupsPages(options: ErrorGroupsPagesOptions): readonly AdminCustomPage[] {
  const path = options.path ?? '/errors';
  return [
    {
      path,
      titleKey: 'admin.errors.title',
      permissions: [ERRORS_READ],
      ...(options.navGroup === undefined ? {} : { navGroup: options.navGroup }),
      component: (props) =>
        ErrorsList({
          store: options.store,
          basePath: new URL(props.url).pathname,
          url: props.url,
        }),
    },
    {
      path: `${path}/:fingerprint`,
      titleKey: 'admin.errors.detail.title',
      permissions: [ERRORS_READ],
      component: (props) => {
        const pathname = new URL(props.url).pathname;
        return ErrorsDetail({
          store: options.store,
          listPath: pathname.slice(0, pathname.lastIndexOf('/')),
          fingerprint: props.params['fingerprint'] ?? '',
        });
      },
    },
  ];
}
