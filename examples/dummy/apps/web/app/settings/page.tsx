/**
 * Preferences. `spa` because it is a form behind auth: the shell is static, the data never is,
 * and nothing here is worth server-rendering.
 *
 * All three pickers write to the **member row**, not to localStorage. That is what makes the
 * digest email, the admin dashboard and a future mobile client agree with this screen. Theme and
 * the digest switch apply instantly through `mutator.ts`'s `setTheme` / `toggleDigestOptIn` —
 * locale and timezone stay behind the explicit "Save" below, in `actions.ts`.
 */

import type { AppTheme } from '@postly/domain';
import { SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { Button, DateTime, Select, Stack, Switch, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { createSignal, For } from 'solid-js';
import { useActor } from '../../shared/actor';
import { client } from '../../shared/client';
import { Layout } from '../layout';
import { memberSelf } from '../orgs/policy';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'spa',
  /**
   * The shell is static, so it carries no server-rendered data to authorise — the route itself
   * has to hold the rule. The same `memberSelf` the save action enforces: one definition, two
   * surfaces, and a signed-out visitor never reaches the shell in the first place.
   */
  policy: memberSelf,
  /** The shell precaches; the preferences themselves are always fetched. */
  offline: 'precache',
  hydrate: 'idle',
  budget: { js: '45kb', lcp: 1800 },
  meta: ({ t }) => ({ title: t('app.settings.metaTitle'), robots: 'noindex' }),
});

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();

  const [locale, setLocale] = createSignal(actor.member.locale);
  const [zone, setZone] = createSignal(actor.member.tz);
  const [theme, setThemeSignal] = createSignal(actor.member.theme);
  const [digestOptIn, setDigestOptInSignal] = createSignal(actor.member.digestOptIn);
  const [saved, setSaved] = createSignal(false);

  const save = async () => {
    // Theme and digest opt-in already applied instantly through their own mutators below; they
    // still ride along here so a caller of `savePreferences` gets back the row it expects.
    await client.savePreferences({
      locale: locale(),
      tz: zone(),
      theme: theme(),
      digestOptIn: digestOptIn(),
    });
    setSaved(true);
  };

  /** Applies instantly and survives offline — the mutator's own local twin, not this "Save". */
  const applyTheme = async (next: AppTheme) => {
    setThemeSignal(next);
    document.documentElement.dataset.theme = next === 'system' ? '' : next;
    await client.setTheme({ memberId: actor.member.id, theme: next });
  };

  const applyDigestOptIn = async (next: boolean) => {
    setDigestOptInSignal(next);
    await client.toggleDigestOptIn({ memberId: actor.member.id, digestOptIn: next });
  };

  return (
    <Layout>
      <Stack gap="6" class={styles.page}>
        <header>
          <h1>{t('app.settings.heading')}</h1>
          <Text tone="muted">{t('app.settings.intro')}</Text>
        </header>

        <Select
          label={t('app.settings.localeLabel')}
          hint={t('app.settings.localeHelp')}
          value={locale()}
          onChange={setLocale}
        >
          <For each={SUPPORTED_LOCALES}>{(value) => <option value={value}>{value}</option>}</For>
        </Select>

        <Select
          label={t('app.settings.timezoneLabel')}
          hint={t('app.settings.timezoneHelp')}
          value={zone()}
          onChange={setZone}
        >
          <For each={SUPPORTED_ZONES}>{(value) => <option value={value}>{value}</option>}</For>
        </Select>

        {/* Immediate feedback that the zone means something: now, as this member will see it. */}
        <p class={styles.preview}>
          <DateTime value={actor.now} zone={zone()} format="long" />
        </p>

        <Select
          label={t('app.settings.themeLabel')}
          value={theme()}
          onChange={(next) => void applyTheme(next)}
        >
          <For each={THEMES}>
            {(value) => (
              <option value={value}>
                {t(
                  value === 'system'
                    ? 'app.settings.themeSystem'
                    : value === 'light'
                      ? 'app.settings.themeLight'
                      : 'app.settings.themeDark',
                )}
              </option>
            )}
          </For>
        </Select>

        <Switch
          label={t('app.settings.digestLabel')}
          hint={t('app.settings.digestHelp')}
          checked={digestOptIn()}
          onChange={(next) => void applyDigestOptIn(next)}
        />

        <div class={styles.actions}>
          <Button onClick={save}>{t('common.save')}</Button>
          <Text tone="muted">{saved() ? t('common.saved') : ''}</Text>
        </div>
      </Stack>
    </Layout>
  );
}
