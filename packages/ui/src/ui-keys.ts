// Every string the design system needs but cannot receive as a prop, one export per key — the one
// list. Read as `UI_KEYS.<name>` (`i18n-keys.ts` imports this module as a namespace), so a bundler
// keeps exactly the keys an island's components read: an object literal kept all of them.

export const close = 'ui.close';
export const cancel = 'ui.cancel';
export const confirm = 'ui.confirm';
export const dismiss = 'ui.dismiss';
export const loading = 'ui.loading';
export const empty = 'ui.empty';
// `ui.error` cannot be a leaf: `ui.error.code|cause|fix` are branches under it, and a catalog is
// authored nested — `parseNestedCatalog` refuses a dot inside a key, so a name is a leaf or a
// branch, never both. Same reason `theme` is `ui.theme.label`.
export const error = 'ui.error.title';
export const retry = 'ui.retry';
export const next = 'ui.next';
export const previous = 'ui.previous';
/** Pagination: back to the first page — the one way back a keyset list has. */
export const first = 'ui.first';
export const page = 'ui.page';
export const sortAscending = 'ui.sort.ascending';
export const sortDescending = 'ui.sort.descending';
export const breadcrumb = 'ui.breadcrumb';
/** AppShell's skip link — the first Tab stop on every page. */
export const skip = 'ui.skip';
/** AppShell's sidebar landmark name. */
export const navigation = 'ui.navigation';
export const menu = 'ui.menu';
export const more = 'ui.more';
export const required = 'ui.required';
export const optional = 'ui.optional';
export const theme = 'ui.theme.label';
export const themeLight = 'ui.theme.light';
export const themeDark = 'ui.theme.dark';
export const themeSystem = 'ui.theme.system';
export const language = 'ui.language';
/** Combobox: how many suggestions the datalist currently offers. Takes `{ count }`. */
export const suggestions = 'ui.suggestions';
/** Combobox: the query matched nothing. */
export const noResults = 'ui.results.empty';
/** InfiniteScroll: the label on the next-page control. */
export const loadMore = 'ui.load.more';
/** InfiniteScroll: announced when the last page has arrived. */
export const endOfList = 'ui.load.end';
/** CopyButton: the control's name before a copy. */
export const copy = 'ui.copy';
/** CopyButton: announced, and the control's name, once the write succeeded. */
export const copied = 'ui.copied';
export const errorCode = 'ui.error.code';
export const errorCause = 'ui.error.cause';
export const errorFix = 'ui.error.fix';
/** SearchableSelect: the field's text when nothing is chosen, and a required one's refusal. */
export const selectNone = 'ui.select.none';
/** SearchableSelect: the list is capped. Takes `{ shown, total }`. */
export const selectMore = 'ui.select.more';
/** SearchableSelect: a chip's remove control. Takes `{ label }`. */
export const selectRemove = 'ui.select.remove';
/** SearchableSelect: the control that empties a many-valued selection. */
export const selectClear = 'ui.select.clear';
/** Charts: a gap — the value is unknown, never zero. The data table's cell and a Gauge's readout. */
export const chartNone = 'ui.chart.none';
/** LiveIndicator: the four states of a live view, each one word beside a shape. */
export const liveLive = 'ui.live.live';
export const liveReconnecting = 'ui.live.reconnecting';
export const livePaused = 'ui.live.paused';
export const liveOffline = 'ui.live.offline';
/** VirtualList: the one way back for a reader who scrolled up from a list that follows its end. */
export const listToEnd = 'ui.list.toEnd';
/** Tree: a node whose children `onExpand` is still fetching. */
export const treeLoading = 'ui.tree.loading';
/** DatePicker: the button that opens the calendar beside the native input. */
export const dateOpen = 'ui.date.open';
/** Calendar: the month controls. */
export const datePreviousMonth = 'ui.date.previousMonth';
export const dateNextMonth = 'ui.date.nextMonth';
/** DateRangePicker: the button that opens the calendar beside the two inputs. */
export const rangeOpen = 'ui.range.open';
/** DateRangePicker/TimeRangePicker: the two ends' labels. */
export const rangeFrom = 'ui.range.from';
export const rangeTo = 'ui.range.to';
/** TimeRangePicker: the custom window's submit. */
export const rangeApply = 'ui.range.apply';
/** TimeRangePicker: the disclosure holding the custom window's form. */
export const rangeCustom = 'ui.range.custom';
/** TimeRangePicker: the URL's window was malformed or backwards, and the default is shown. */
export const rangeInvalid = 'ui.range.invalid';
/** ShortcutSheet: its title, and the legend line of the `?` that opens it. */
export const shortcuts = 'ui.shortcuts';
/** Stepper, below `sm`: takes `{ current, total, label }`. */
export const step = 'ui.step';
/** PullToRefresh: the hint while pulling, past the threshold, and while the refresh runs. */
export const refreshPull = 'ui.refresh.pull';
export const refreshRelease = 'ui.refresh.release';
export const refreshBusy = 'ui.refresh.busy';
/** SortableList/Board: the drag handle's name, and the no-script move submit. */
export const sortHandle = 'ui.sort.handle';
/** Board, no script: the target column `Select`'s label. */
export const sortTarget = 'ui.sort.target';
/** SortableList/Board: announced on lift, each step, the drop and a cancel or refused move. Each takes `{ position, total, group }`. */
export const sortLift = 'ui.sort.lift';
export const sortMoved = 'ui.sort.moved';
export const sortDropped = 'ui.sort.dropped';
export const sortCancelled = 'ui.sort.cancelled';
/** SortableList, no script: the two form buttons beside each row. */
export const sortUp = 'ui.sort.up';
export const sortDown = 'ui.sort.down';
/** SplitPane: the separator's name. */
export const paneResize = 'ui.pane.resize';
/** CodeBlock: the scroll region's name, and the wrap toggle. */
export const codeRegion = 'ui.code.region';
export const codeWrap = 'ui.code.wrap';
/** TerminalView: the output region's name. */
export const codeTerminal = 'ui.code.terminal';
/** DiffView: the region, the spoken gutters, the next-change control and a fold. `folded` takes `{ count }`. */
export const diffRegion = 'ui.diff.region';
export const diffAdded = 'ui.diff.added';
export const diffRemoved = 'ui.diff.removed';
export const diffNext = 'ui.diff.next';
export const diffFolded = 'ui.diff.folded';
/** LogViewer: the region, the text filter, the level filter and its "every level", follow, and a cap. `capped` takes `{ count }`. */
export const logRegion = 'ui.log.region';
export const logFilter = 'ui.log.filter';
export const logLevel = 'ui.log.level';
export const logAll = 'ui.log.all';
export const logFollow = 'ui.log.follow';
export const logCapped = 'ui.log.capped';
