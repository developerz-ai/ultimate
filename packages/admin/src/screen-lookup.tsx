// A resource's lookup screen: the picker for every filter and every input that references it.
// Zero script — a GET form over the label, results as links, keyset paging as links. Opened from
// a filter it carries `return` and `as`, and each result links back to that list with the
// parameter set to the row's id; opened on its own, a result opens the row.

import { t } from '@ultimat3/i18n';
import { Button, Card, ErrorState, Input, Pagination } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp } from './admin';
import styles from './admin.module.scss';
import { canOperate } from './crud';
import { AdminFilterInvalidError } from './errors';
import { FILTER_PREFIX } from './list-filters';
import { CURSOR_PARAM } from './list-request';
import { adminLookup } from './relations';
import type { AdminResource } from './resource';
import { type AdminScreen, framed, lookupHref, refused } from './screen-frame';

const TERM_PARAM = 'term';
const RETURN_PARAM = 'return';
const AS_PARAM = 'as';
const KNOWN: readonly string[] = [TERM_PARAM, CURSOR_PARAM, RETURN_PARAM, AS_PARAM];

interface Asked {
  readonly term: string;
  readonly cursor: string | null;
  /** The list to go back to, and the filter parameter to set on it. Both, or neither. */
  readonly back: { readonly to: string; readonly as: string } | null;
}

/**
 * What the URL asks for. `return` is followed by a link this screen renders, so it is held to the
 * admin's own paths — an absolute URL or a `//host` here is somebody else's page wearing the
 * admin's chrome — and `as` to a filter parameter, the only thing a lookup ever sets.
 */
function askedOf(app: AdminApp, resource: AdminResource, url: URL): Asked {
  const refuse = (asked: string, cause: string): never => {
    throw new AdminFilterInvalidError({ entity: resource.name, asked, cause, known: KNOWN });
  };
  for (const key of url.searchParams.keys()) {
    if (!KNOWN.includes(key)) refuse(key, 'is not a parameter a lookup reads');
  }
  const to = url.searchParams.get(RETURN_PARAM) ?? '';
  const as = url.searchParams.get(AS_PARAM) ?? '';
  if ((to === '') !== (as === ''))
    refuse(RETURN_PARAM, 'and `as` are given together or not at all');
  if (to !== '' && !(to === app.basePath || to.startsWith(`${app.basePath}/`))) {
    refuse(`${RETURN_PARAM}=${to}`, `is not a path under ${app.basePath}`);
  }
  if (as !== '' && !as.startsWith(FILTER_PREFIX)) {
    refuse(`${AS_PARAM}=${as}`, `is not a filter parameter (${FILTER_PREFIX}<field>)`);
  }
  return {
    term: url.searchParams.get(TERM_PARAM) ?? '',
    cursor: url.searchParams.get(CURSOR_PARAM),
    back: to === '' ? null : { to, as },
  };
}

/** The list a result returns to, with the picked id set and the old page position dropped. */
const picked = (back: { readonly to: string; readonly as: string }, id: string): string => {
  const [path = '', search = ''] = back.to.split('?', 2);
  const query = new URLSearchParams(search);
  query.set(back.as, id);
  query.delete(CURSOR_PARAM);
  return `${path}?${query.toString()}`;
};

export function lookupScreen(app: AdminApp, resource: AdminResource): AdminScreen {
  const here = lookupHref(app.basePath, resource);
  return async (request) => {
    const url = new URL(request.url);
    // Decided before the URL is read: an actor who may not list the target learns nothing about
    // which parameters its lookup takes.
    if (!canOperate(resource, 'list', request.ctx)) {
      const denied = await adminLookup(resource, request.ctx);
      if (!denied.ok) return refused(app, request, resource.titleKey, denied.decision);
    }
    let asked: Asked;
    try {
      asked = askedOf(app, resource, url);
    } catch (error) {
      if (!(error instanceof AdminFilterInvalidError)) throw error;
      return framed(app, request, resource.titleKey, <ErrorState error={error} />, 400);
    }
    const result = await adminLookup(resource, request.ctx, {
      term: asked.term,
      cursor: asked.cursor,
    });
    if (!result.ok) return refused(app, request, resource.titleKey, result.decision);

    const state = (cursor: string | null): string => {
      const query = new URLSearchParams();
      if (asked.term !== '') query.set(TERM_PARAM, asked.term);
      if (asked.back !== null) {
        query.set(RETURN_PARAM, asked.back.to);
        query.set(AS_PARAM, asked.back.as);
      }
      if (cursor !== null) query.set(CURSOR_PARAM, cursor);
      const search = query.toString();
      return search === '' ? here : `${here}?${search}`;
    };
    const hidden = (name: string, value: string): JSX.Element => (
      <input type="hidden" name={name} value={value} />
    );
    const { page } = result;

    return framed(
      app,
      request,
      resource.titleKey,
      <Card header={<h2>{t('admin.lookup.title', { entity: t(resource.titleKey) })}</h2>}>
        <search>
          <form class={styles['filters']} method="get" action={here}>
            <Input
              name={TERM_PARAM}
              type="search"
              value={asked.term}
              aria-label={t('admin.search.label')}
              placeholder={t('admin.lookup.placeholder')}
            />
            {asked.back === null ? null : hidden(RETURN_PARAM, asked.back.to)}
            {asked.back === null ? null : hidden(AS_PARAM, asked.back.as)}
            <Button type="submit" variant="secondary">
              {t('admin.filter.apply')}
            </Button>
          </form>
        </search>
        {result.options.length === 0 ? (
          <p class="x-admin-empty">{t('admin.list.empty')}</p>
        ) : (
          <ul class={styles['list']}>
            {result.options.map((option) => (
              <li>
                <a
                  href={
                    asked.back === null
                      ? `${app.basePath}${resource.path}/${option.id}`
                      : picked(asked.back, option.id)
                  }
                >
                  {option.label}
                </a>{' '}
                <span class={styles['mono']}>{option.id}</span>
              </li>
            ))}
          </ul>
        )}
        <Pagination
          nextCursor={page.hasMore ? (page.nextCursor ?? undefined) : undefined}
          prevCursor={page.prevCursor ?? undefined}
          hrefFor={(cursor) => state(cursor)}
        />
      </Card>,
    );
  };
}
