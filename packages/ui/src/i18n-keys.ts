// Every string the design system needs but cannot receive as a prop. Components
// resolve these through the context translator, so an app can localise the whole
// system by adding one namespace to its catalog — and a miss is loud (⟦key⟧).

export const UI_KEYS = {
  close: 'ui.close',
  cancel: 'ui.cancel',
  confirm: 'ui.confirm',
  dismiss: 'ui.dismiss',
  loading: 'ui.loading',
  empty: 'ui.empty',
  error: 'ui.error',
  retry: 'ui.retry',
  next: 'ui.next',
  previous: 'ui.previous',
  page: 'ui.page',
  sortAscending: 'ui.sort.ascending',
  sortDescending: 'ui.sort.descending',
  breadcrumb: 'ui.breadcrumb',
  /** AppShell's skip link — the first Tab stop on every page. */
  skip: 'ui.skip',
  /** AppShell's sidebar landmark name. */
  navigation: 'ui.navigation',
  menu: 'ui.menu',
  more: 'ui.more',
  required: 'ui.required',
  optional: 'ui.optional',
  theme: 'ui.theme',
  themeLight: 'ui.theme.light',
  themeDark: 'ui.theme.dark',
  themeSystem: 'ui.theme.system',
  language: 'ui.language',
  /** Combobox: how many suggestions the datalist currently offers. Takes `{ count }`. */
  suggestions: 'ui.suggestions',
  /** Combobox: the query matched nothing. */
  noResults: 'ui.results.empty',
  /** InfiniteScroll: the label on the next-page control. */
  loadMore: 'ui.load.more',
  /** InfiniteScroll: announced when the last page has arrived. */
  endOfList: 'ui.load.end',
  errorCode: 'ui.error.code',
  errorCause: 'ui.error.cause',
  errorFix: 'ui.error.fix',
} as const;

export type UiKey = (typeof UI_KEYS)[keyof typeof UI_KEYS];
