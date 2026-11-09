// The admin as one request reached it: the same declaration, its links rooted where the request
// was SERVED — behind an HTTP base path, under a routed locale, or both (`/myapp/es/admin`). Every
// link, form action and redirect a screen writes starts from `app.basePath` or `app.home`, so this
// one substitution keeps every click where the operator is instead of dropping the prefix.

import type { AdminApp } from './admin';

/**
 * `app` itself when it was reached at its declared base path; otherwise a copy whose `basePath` is
 * the pathname up to and including the declared base (`/myapp/es/admin`) and whose `home` is the
 * part before it with a trailing slash (`/myapp/es/`). The first match from the left is the mount:
 * a row id or a page path that repeats the base comes after it. The route table (`routes`) is left
 * as declared: the host matches on the stripped route path, and the audit names the route.
 */
export function adminAppFor(app: AdminApp, url: string): AdminApp {
  const segments = (URL.parse(url, 'http://localhost')?.pathname ?? '').split('/').slice(1);
  const base = app.basePath.split('/').filter((segment) => segment !== '');
  for (let at = 0; at + base.length <= segments.length; at += 1) {
    if (!base.every((segment, i) => segments[at + i] === segment)) continue;
    if (at === 0) return app;
    const served = segments.slice(0, at);
    return {
      ...app,
      basePath: `/${[...served, ...base].join('/')}`,
      home: `/${served.join('/')}/`,
    };
  }
  return app;
}
