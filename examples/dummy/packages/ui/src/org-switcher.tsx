/**
 * Org selection. A native `<select>` inside a native `<form>`: it works with JavaScript disabled,
 * on a `hydrate: 'never'` route, and in the admin app, without three implementations.
 */

import { useT } from '@postly/i18n';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import styles from './org-switcher.module.scss';

export type SwitchableOrg = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
};

export type OrgSwitcherProps = {
  readonly orgs: readonly SwitchableOrg[];
  readonly currentOrgId: string;
  /** Server route that sets the active org cookie and redirects back. */
  readonly action: string;
};

export const OrgSwitcher = (props: OrgSwitcherProps): JSX.Element => {
  const t = useT();

  return (
    <form class={styles.form} method="post" action={props.action}>
      <label class={styles.label} for="org-switcher">
        {t('orgs.switcherLabel')}
      </label>
      <select
        class={styles.select}
        id="org-switcher"
        name="orgId"
        // Submitting on change is the enhancement; the button below is the baseline.
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <For each={props.orgs}>
          {(org) => (
            <option value={org.id} selected={org.id === props.currentOrgId}>
              {org.name}
            </option>
          )}
        </For>
      </select>
      <button class={styles.submit} type="submit">
        {t('common.save')}
      </button>
    </form>
  );
};
