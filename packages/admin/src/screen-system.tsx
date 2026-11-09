// The two built-in screens that are neither a resource nor the jobs dashboard (`jobs/`): the
// audit trail and cross-entity search. Each is decided by its own route's permission pair through
// `decideAll` — the same gate a custom page gets — before anything is read.

import { t } from '@ultimat3/i18n';
import { Button, Card, Checkbox, Field, Input, Link, Select } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp, AdminRoute } from './admin';
import styles from './admin.module.scss';
import { type AuditEntry, type AuditQuery, auditCursorOf, auditEntryMatches } from './audit';
import { AUDIT_OUTCOMES, type AuditRequest, auditHref, auditRequestOf } from './audit-request';
import { canOperate } from './crud';
import { AuditDiff, maskedFieldsOf, operationLabel } from './detail';
import { type AdminScreen, guardedScreen } from './screen-frame';
import { adminSearch } from './search';

/** How many audit entries one screen shows — newest first, from whichever log the admin names. */
const AUDIT_PAGE = 100;

/** `datetime-local` holds minutes and says UTC beside the box: the parser reads it back as UTC. */
const minuteOf = (instant: string | undefined): string => instant?.slice(0, 16) ?? '';

/** One native GET form at the screen's own path: submitting it IS the navigation. No script. */
function AuditFilter(props: {
  readonly action: string;
  readonly asked: AuditRequest;
}): JSX.Element {
  const { asked } = props;
  const filtered = Object.keys(asked).some((key) => key !== 'before');
  return (
    <search>
      <form class={styles['filters']} method="get" action={props.action}>
        <Field label={t('admin.audit.filter.entity')}>
          {(own) => <Input id={own.id} name="entity" value={asked.entity ?? ''} />}
        </Field>
        <Field label={t('admin.audit.filter.actor')}>
          {(own) => <Input id={own.id} name="actor" value={asked.actorId ?? ''} />}
        </Field>
        <Field label={t('admin.audit.filter.outcome')}>
          {(own) => (
            <Select
              id={own.id}
              name="outcome"
              value={asked.outcome ?? ''}
              options={[
                { value: '', label: t('admin.filter.any') },
                ...AUDIT_OUTCOMES.map((one) => ({
                  value: one,
                  label: t(`admin.audit.outcome.${one}`),
                })),
              ]}
            />
          )}
        </Field>
        <Field label={t('admin.audit.filter.since')}>
          {(own) => (
            <Input
              id={own.id}
              name="since"
              type="datetime-local"
              suffix="UTC"
              value={minuteOf(asked.since)}
            />
          )}
        </Field>
        <Field label={t('admin.audit.filter.until')}>
          {(own) => (
            <Input
              id={own.id}
              name="until"
              type="datetime-local"
              suffix="UTC"
              value={minuteOf(asked.until)}
            />
          )}
        </Field>
        <Checkbox
          name="changes"
          value="1"
          checked={asked.changes === true}
          label={t('admin.audit.filter.changes')}
        />
        <div class={styles['actions']}>
          <Button type="submit" variant="secondary">
            {t('admin.filter.apply')}
          </Button>
          {filtered ? (
            <Link appearance="button" variant="ghost" tone="neutral" href={props.action}>
              {t('admin.filter.clear')}
            </Link>
          ) : null}
        </div>
      </form>
    </search>
  );
}

export function auditScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return guardedScreen(app, route, async (request) => {
    // Refused before anything is read: a parameter this screen does not answer is a 400 naming
    // what it does (`guardedScreen`), never the unfiltered trail.
    const asked = auditRequestOf(new URL(request.url));
    // The trail's links and its filter form point at the page AS SERVED — under `/es/admin/audit`
    // that keeps the locale, where the declared `route.path` dropped it on every click.
    const here = new URL(request.url).pathname;
    // The actor's tenant's trail: `audit:read` held in org A is not a read of org B's operators,
    // their ids or what they touched. An actor with no org — the platform — reads every tenant's.
    // Never a parameter: the URL cannot name another tenant.
    const orgId = request.ctx.actor.orgId;
    const query: AuditQuery = {
      ...asked,
      limit: AUDIT_PAGE,
      ...(orgId === undefined ? {} : { orgId }),
    };
    const page = await app.audit.entries(query);
    // An app's own log that ignores a field — `outcome`, a bound, the tenant — answers a short
    // page here, never a wider one. The cursor is the page's as the log answered it, so paging
    // still walks every entry.
    const entries = page.filter((entry) => auditEntryMatches(entry, query));
    const last = page.length < AUDIT_PAGE ? null : auditCursorOf(page);
    const resourceOf = (entry: AuditEntry) =>
      app.resources.find((resource) => resource.name === entry.entity);
    const rowHrefOf = (entry: AuditEntry): string | null => {
      const resource = resourceOf(entry);
      return resource === undefined ||
        entry.entityId === null ||
        !canOperate(resource, 'detail', request.ctx)
        ? null
        : `${app.basePath}${resource.path}/${encodeURIComponent(entry.entityId)}`;
    };
    const { before: _page, ...filters } = asked;
    return (
      <Card>
        <AuditFilter action={here} asked={asked} />
        {entries.length === 0 ? (
          <p class="x-admin-empty">{t('admin.audit.empty')}</p>
        ) : (
          <ol class={styles['list']}>
            {entries.map((entry) => {
              const href = rowHrefOf(entry);
              const resource = resourceOf(entry);
              return (
                <li>
                  <code>{entry.at}</code>{' '}
                  <a href={auditHref(here, { ...filters, actorId: entry.actor.id })}>
                    {entry.actor.id}
                  </a>{' '}
                  <span>{operationLabel(entry)}</span>{' '}
                  <span class={styles['mono']}>{entry.entity}</span>{' '}
                  {href === null ? null : <a href={href}>{entry.entityId}</a>}{' '}
                  <span data-outcome={entry.outcome}>
                    {t(`admin.audit.outcome.${entry.outcome}`)}
                  </span>
                  <AuditDiff
                    diff={entry.diff}
                    masked={resource === undefined ? new Set() : maskedFieldsOf(resource)}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {last === null ? null : (
          <Link href={auditHref(here, { ...filters, before: last })}>{t('admin.audit.older')}</Link>
        )}
      </Card>
    );
  });
}

/** `?term=` — the shell's search box is a native GET at this route. */
export function searchScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return guardedScreen(app, route, async (request) => {
    const term = new URL(request.url).searchParams.get('term') ?? '';
    const result = await adminSearch({ term, resources: app.resources, ctx: request.ctx });
    return (
      <Card>
        {result.hits.length === 0 ? (
          <p class="x-admin-empty">{t('admin.list.empty')}</p>
        ) : (
          <ul class={styles['list']}>
            {result.hits.map((hit) => (
              <li>
                <a href={`${app.basePath}${hit.href}`}>{hit.label}</a>{' '}
                <span class={styles['mono']}>{hit.entity}</span>
              </li>
            ))}
          </ul>
        )}
        {result.skipped.map((skip) => (
          <p class={styles['note']}>
            <span class={styles['mono']}>{skip.entity}</span> {t(skip.reason)}
          </p>
        ))}
      </Card>
    );
  });
}
