/**
 * The states `/settings`' editor can be photographed in, and neither of them can be reached by
 * clicking: one is what the screen looks like when the preference-options read comes back empty,
 * the other is the retry banner after a save the server refused. Reaching either by hand means
 * breaking a server on purpose and then getting a screenshot before it recovers.
 *
 * `x shot --island settings --json` takes both, in both themes, into `.x/shot/island/settings/`.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely — three tools read this file and only one of them has a
 * browser. `assertIslandStatesPure` is the rule; `X_TEST_ISLAND_STATES_NOT_PURE` is what it throws.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross
 * the seam as JSON in the document, so the SERVER translates and the browser is handed text. These
 * are the text the server would have handed it.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { SettingsProps } from './settings.island';

const LABELS: SettingsProps['labels'] = {
  locale: 'Language',
  localeHelp: 'Dates, numbers and currency follow this choice.',
  timezone: 'Time zone',
  timezoneHelp: 'Everything with a time on it is rendered in this zone.',
  theme: 'Theme',
  digest: 'Weekly digest',
  digestHelp: 'One email a week, on Monday.',
  save: 'Save',
  saved: 'Saved',
  retry: 'That did not save. Try again.',
};

/** What a working read hands the editor — the baseline each state below departs from. */
const BASE = {
  endpoint: '/api/save-preferences',
  nowIso: '2026-03-04T09:00:00.000Z',
  locale: 'en',
  timezone: 'Europe/Bucharest',
  theme: 'system',
  digestOptIn: true,
  locales: [
    { value: 'en', label: 'English' },
    { value: 'ro', label: 'Română' },
  ],
  timezones: [
    { value: 'Europe/Bucharest', label: 'Bucharest' },
    { value: 'UTC', label: 'UTC' },
  ],
  themes: [
    { value: 'system', label: 'Match my system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ],
  labels: LABELS,
} satisfies SettingsProps;

export const settingsStates = defineIslandStates({
  island: 'apps/web/app/settings/settings.island.tsx',
  // The zone the picture renders in, pinned with the instant: this editor's preview formats
  // `nowIso` through `Intl` with an explicit zone, so leaving the zone ambient would make the same
  // state photograph differently on two machines.
  timeZone: 'Europe/Bucharest',
  now: '2026-03-04T09:00:00.000Z',
  // The FRAME, and it is declared rather than cropped: the shipped browser port takes no clip
  // rectangle, so the picture is exactly this box. A reviewer is a vision model and its pixels are
  // the scarce resource — 1280x800 of a form this size is mostly background.
  viewport: { width: 720, height: 560 },
  states: [
    {
      id: 'empty-options',
      title: 'the preference-options read answered nothing',
      note: 'you cannot reach this by clicking: the server always sends the full lists, so an empty one means its read failed and the editor renders three selects with nothing in them',
      props: {
        ...BASE,
        locales: [],
        timezones: [],
        themes: [],
      } satisfies SettingsProps,
    },
    {
      id: 'save-failed',
      title: 'the save came back non-2xx and the retry banner is up',
      note: 'you cannot reach this by clicking without a server that really refuses the write; `status` is the prop that makes the banner addressable',
      props: { ...BASE, status: 'failed' } satisfies SettingsProps,
      // Declared even though this state never clicks Save: an unstubbed request FAILS the run, so
      // the fixture is what proves the picture is of the banner and not of a hung fetch.
      routes: [
        { match: 'POST /api/save-preferences', respond: { kind: 'json', status: 500, body: {} } },
      ],
    },
  ],
});
