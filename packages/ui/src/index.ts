// The public surface of @ultimat3/ui. Explicit exports only — this list is the
// design system's contract, and anything not named here is internal.

// Ambient declarations are not reachable through imports, so a consuming app's
// program would never load them — every `*.module.scss` import in this package
// would be TS2307 there. The reference pulls the contract along with the entry.
/// <reference path="./scss.d.ts" />

// Bare, and above every re-export: `theme/ambient.ts` registers the server's `useUi()` reader at
// import, and a bundler may drop a re-exported module whose binding nobody used. A browser build
// resolves this specifier to `theme/ambient.browser.ts` through `package.json`'s `browser` field,
// so an island never carries the i18n barrel for it (issue #490).
import './theme/ambient';

export type { FocusTrap } from './a11y';
export {
  announce,
  focusTrap,
  liveRegionAttrs,
  resetUseIdCounter,
  rovingTabindex,
  useId,
} from './a11y';
export type { AccordionProps } from './components/Accordion';
// --- components --------------------------------------------------------------
export { Accordion } from './components/Accordion';
export type { AlertProps } from './components/Alert';
export { Alert } from './components/Alert';
export type { AppShellProps } from './components/AppShell';
export { AppShell } from './components/AppShell';
export type { AsyncRegionProps } from './components/AsyncRegion';
// --- async regions: the one four-way decision, and the component that renders it --------------
export { AsyncRegion } from './components/AsyncRegion';
export type { AvatarProps } from './components/Avatar';
export { Avatar, initialsOf } from './components/Avatar';
export { shellIds } from './components/app-shell-view';
export type { AsyncBranch, AsyncFlags } from './components/async-branch';
export {
  asyncBranch,
  asyncStateOf,
  isBusyBranch,
  isEmptyData,
  reserveBlockSize,
} from './components/async-branch';
export type { BadgeProps } from './components/Badge';
export { Badge } from './components/Badge';
export type {
  BarChartPointsProps,
  BarChartProps,
  BarChartSeriesProps,
} from './components/BarChart';
export { BarChart } from './components/BarChart';
export type { BoardProps } from './components/Board';
export { Board } from './components/Board';
export type { BottomNavProps } from './components/BottomNav';
export { BottomNav } from './components/BottomNav';
export type { BreadcrumbItem, BreadcrumbProps } from './components/Breadcrumb';
export { Breadcrumb } from './components/Breadcrumb';
export type { ButtonProps } from './components/Button';
export { Button } from './components/Button';
export type { BarRect, ChartPoint } from './components/bar-chart-view';
export { barRects } from './components/bar-chart-view';
export type { CalendarLinkProps, CalendarProps, CalendarSelectProps } from './components/Calendar';
export { Calendar } from './components/Calendar';
export type { CardProps, Elevation } from './components/Card';
export { Card } from './components/Card';
export type { ChartFrameProps } from './components/ChartFrame';
export { ChartFrame } from './components/ChartFrame';
export type { CheckboxProps } from './components/Checkbox';
export { Checkbox } from './components/Checkbox';
export type { CodeBlockProps } from './components/CodeBlock';
export { CodeBlock } from './components/CodeBlock';
export type { ComboboxProps } from './components/Combobox';
export { Combobox } from './components/Combobox';
export type { CommandPaletteLabels, CommandPaletteProps } from './components/CommandPalette';
export { CommandPalette } from './components/CommandPalette';
export type {
  ConfirmDialogIslandProps,
  ConfirmDialogPostProps,
  ConfirmDialogProps,
} from './components/ConfirmDialog';
export { ConfirmDialog } from './components/ConfirmDialog';
export type { ContainerProps } from './components/Container';
export { Container } from './components/Container';
export type { CopyButtonProps } from './components/CopyButton';
export { CopyButton } from './components/CopyButton';
export type { CalendarDay } from './components/calendar-view';
export { stepDay } from './components/calendar-view';
export type { ChartSeries, ChartTableInput, MarkerShape } from './components/chart-frame-view';
export { CHART_SERIES_SLOTS, chartTable } from './components/chart-frame-view';
export { niceTicks } from './components/chart-ticks-view';
export type { ComboboxOption } from './components/combobox-filter';
export { filterOptions, normalizeQuery } from './components/combobox-filter';
export type { CommandPaletteItem } from './components/command-palette-view';
export {
  filterItems,
  keyAction,
  settleActive,
  stepActive,
} from './components/command-palette-view';
export type {
  Column,
  DataTableCallbackProps,
  DataTableLinkProps,
  DataTableProps,
} from './components/DataTable';
export { DataTable } from './components/DataTable';
export type { DatePickerProps } from './components/DatePicker';
export { DatePicker } from './components/DatePicker';
export type { DateRangePickerProps } from './components/DateRangePicker';
export { DateRangePicker } from './components/DateRangePicker';
export type { DateTimeProps } from './components/DateTime';
export { DateTime } from './components/DateTime';
export type { DescriptionListProps } from './components/DescriptionList';
export { DescriptionList } from './components/DescriptionList';
export type { DialogProps } from './components/Dialog';
export { Dialog } from './components/Dialog';
export type { DiffViewPatchProps, DiffViewProps, DiffViewTextProps } from './components/DiffView';
export { DiffView } from './components/DiffView';
export type { DividerProps } from './components/Divider';
export { Divider } from './components/Divider';
export type { DonutChartProps } from './components/DonutChart';
export { DonutChart } from './components/DonutChart';
export type { DrawerProps } from './components/Drawer';
export { Drawer } from './components/Drawer';
export type { DropzoneProps } from './components/Dropzone';
export { Dropzone } from './components/Dropzone';
export type { DateStyle, DateTimeFormatter } from './components/date-time-view';
export { dateTimeView, toDate, toInstant } from './components/date-time-view';
export type { EmptyStateProps } from './components/EmptyState';
export { EmptyState } from './components/EmptyState';
export type { ErrorStateProps } from './components/ErrorState';
export { ErrorState, errorParts } from './components/ErrorState';
export type { FieldControl, FieldProps } from './components/Field';
export { Field } from './components/Field';
export type { FileInputProps } from './components/FileInput';
export { FileInput } from './components/FileInput';
export type { FormProps } from './components/Form';
export { Form } from './components/Form';
export { formatFileSize, selectFiles } from './components/file-input-view';
export type { GaugeProps } from './components/Gauge';
export { Gauge } from './components/Gauge';
export type { GridProps } from './components/Grid';
export { Grid } from './components/Grid';
export type { HeatStripProps } from './components/HeatStrip';
export { HeatStrip } from './components/HeatStrip';
export { headingTag } from './components/heading-level';
export type { HeatRow } from './components/heat-strip-view';
export type { IconProps } from './components/Icon';
// --- icons: the glyphs themselves are per-icon modules, `@ultimat3/ui/icons/<name>` ---------
export { Icon } from './components/Icon';
export type { IconButtonProps } from './components/IconButton';
export { IconButton } from './components/IconButton';
export type { ImageBaseProps, ImageProps } from './components/Image';
export { Image } from './components/Image';
export type { InfiniteScrollProps } from './components/InfiniteScroll';
export { InfiniteScroll } from './components/InfiniteScroll';
export type { InlineBarProps } from './components/InlineBar';
export { InlineBar } from './components/InlineBar';
export type { InputProps, InputType } from './components/Input';
export { Input } from './components/Input';
export type { IconGlyph } from './components/icon-glyph';
export { iconElements } from './components/icon-glyph';
export type { ImageSourceSet } from './components/image-source';
export { boxFor, variantSrcset } from './components/image-source';
export type { JsonViewProps } from './components/JsonView';
export { JsonView } from './components/JsonView';
export type { KbdProps } from './components/Kbd';
export { Kbd } from './components/Kbd';
export type { AreaChartProps, LineChartProps } from './components/LineChart';
export { AreaChart, LineChart } from './components/LineChart';
export type { ButtonLinkProps, LinkProps, TextLinkProps } from './components/Link';
export { Link } from './components/Link';
export type { LiveIndicatorProps } from './components/LiveIndicator';
export { LiveIndicator } from './components/LiveIndicator';
export type { LocaleSwitcherProps } from './components/LocaleSwitcher';
export { LocaleSwitcher, localeLabel } from './components/LocaleSwitcher';
export type { LogViewerProps } from './components/LogViewer';
export { LogViewer } from './components/LogViewer';
export type { LogLine } from './components/log-viewer-view';
export type { MarkdownProps } from './components/Markdown';
export { Markdown } from './components/Markdown';
export type { MenuItem, MenuProps } from './components/Menu';
export { Menu } from './components/Menu';
export type { MeterProps } from './components/Meter';
export { Meter } from './components/Meter';
export type { MoneyProps } from './components/Money';
export { Money } from './components/Money';
export type { MoneyInput } from './components/money-view';
// --- formatting cores (pure, renderer-free) ----------------------------------
export { moneyText } from './components/money-view';
export type { NavListProps } from './components/NavList';
export { NavList } from './components/NavList';
export { currentOf } from './components/nav-list-view';
export type { PageHeaderProps } from './components/PageHeader';
export { PageHeader } from './components/PageHeader';
export type {
  PaginationCallbackProps,
  PaginationLinkProps,
  PaginationProps,
} from './components/Pagination';
export { Pagination } from './components/Pagination';
export type { Placement, PopoverProps } from './components/Popover';
export { Popover } from './components/Popover';
export type { PullToRefreshProps } from './components/PullToRefresh';
export { PullToRefresh } from './components/PullToRefresh';
export type { QrCodeProps } from './components/QrCode';
export { QrCode } from './components/QrCode';
export type { QrMatrix } from './components/qr-matrix';
export { encodeQr } from './components/qr-matrix';
export type { RadioProps } from './components/Radio';
export { Radio } from './components/Radio';
export type { RelativeTimeProps } from './components/RelativeTime';
export { RelativeTime } from './components/RelativeTime';
export { rankOptions } from './components/rank-options';
export type {
  SearchableSelectManyProps,
  SearchableSelectOneProps,
  SearchableSelectProps,
} from './components/SearchableSelect';
export { SearchableSelect } from './components/SearchableSelect';
export type { SectionProps } from './components/Section';
export { Section } from './components/Section';
export type { SelectOption, SelectProps } from './components/Select';
export { Select } from './components/Select';
export type { ShortcutSheetProps } from './components/ShortcutSheet';
export { ShortcutSheet } from './components/ShortcutSheet';
export type { SkeletonProps } from './components/Skeleton';
export { Skeleton } from './components/Skeleton';
export type { SliderProps } from './components/Slider';
export { Slider } from './components/Slider';
export type { SortableListProps } from './components/SortableList';
export { SortableList } from './components/SortableList';
export type { SparklineProps } from './components/Sparkline';
export { Sparkline } from './components/Sparkline';
export type { SpinnerProps } from './components/Spinner';
export { Spinner } from './components/Spinner';
export type { SplitPaneProps } from './components/SplitPane';
export { SplitPane } from './components/SplitPane';
export type { StackProps } from './components/Stack';
export { Stack } from './components/Stack';
export type { StatTileProps } from './components/StatTile';
export { StatTile } from './components/StatTile';
export type { StepperProps } from './components/Stepper';
export { Stepper } from './components/Stepper';
export type { SwitchProps } from './components/Switch';
export { Switch } from './components/Switch';
export type { SearchableOption } from './components/searchable-select-view';
export type { SortDirection, SortState } from './components/sort-state';
export type { SparklinePoint } from './components/sparkline-view';
export { sparklinePath } from './components/sparkline-view';
export type { StatDelta } from './components/stat-delta';
export { deltaMood, deltaOf } from './components/stat-delta';
export type { TableProps } from './components/Table';
export { Table } from './components/Table';
export type { TabsButtonProps, TabsLinkProps, TabsProps } from './components/Tabs';
export { Tabs } from './components/Tabs';
export type { TerminalViewProps } from './components/TerminalView';
export { TerminalView } from './components/TerminalView';
export type { TextProps } from './components/Text';
export { Text } from './components/Text';
export type { TextareaProps } from './components/Textarea';
export { Textarea } from './components/Textarea';
export type { ThemeToggleProps } from './components/ThemeToggle';
export { ThemeToggle } from './components/ThemeToggle';
export type { TimelineProps } from './components/Timeline';
export { Timeline } from './components/Timeline';
export type { TimeRangePickerProps } from './components/TimeRangePicker';
export { TimeRangePicker } from './components/TimeRangePicker';
export type { ToastProps, ToastRegionProps } from './components/Toast';
export { Toast, ToastRegion } from './components/Toast';
export type { ToasterProps } from './components/Toaster';
export { Toaster } from './components/Toaster';
export type { ToolbarProps } from './components/Toolbar';
export { Toolbar } from './components/Toolbar';
export type { TooltipProps } from './components/Tooltip';
export { Tooltip } from './components/Tooltip';
export type { TreeLinkProps, TreeProps, TreeSelectProps } from './components/Tree';
export { Tree } from './components/Tree';
export type { TreeNode } from './components/tree-view';
export { useCommandPalette } from './components/use-command-palette';
export type { VirtualListProps } from './components/VirtualList';
export { VirtualList } from './components/VirtualList';
export type { Align, Size, Tone } from './components/variants';
// --- variants ----------------------------------------------------------------
export { TONES } from './components/variants';
export { headingIds, headingSlug } from './content/heading-slug';
export type { Language, Token } from './content/highlight';
export { defineLanguage, highlight } from './content/highlight';
export { allLanguages } from './content/languages/all';
export { diffLanguage } from './content/languages/diff';
export { htmlLanguage } from './content/languages/html';
export { jsonLanguage } from './content/languages/json';
export { shellLanguage } from './content/languages/shell';
export { sqlLanguage } from './content/languages/sql';
export { tsLanguage } from './content/languages/ts';
export { yamlLanguage } from './content/languages/yaml';
export { parseMarkdown } from './content/markdown-parse';
export { MARKDOWN_MAX_CHARS } from './content/markdown-tree';
// --- helpers -----------------------------------------------------------------
export { cx } from './cx';
export type { Debounced } from './debounce';
export { debounce } from './debounce';
export type { SortMove } from './drag/sort-view';
export type { UiErrorCode } from './errors';
export {
  insufficientContrastError,
  invalidIconDataError,
  invalidValueError,
  providerNeedsRuntimeError,
  runtimeMissingError,
  UI_ERROR_CODES,
  UiError,
} from './errors';
// --- forms: the binding between an action's input schema and Field's error slot ---------------
export { fieldSelector, MAX_FIELD_INDEX, parseFieldPath } from './form/field-path';
export type { FormBinding } from './form/form-binding';
export { formBinding } from './form/form-binding';
export type { FormIssue } from './form/form-issue';
export { issuesFromRejection, issuesFromValidation } from './form/form-issue';
export { errorOf, firstInvalidField } from './form/form-state';
export { valuesOfForm } from './form/form-values';
export { useForm } from './form/use-form';
export type { HotkeyTable } from './hotkeys-view';
export { hotkeyAction } from './hotkeys-view';
export type { UiKey } from './i18n-keys';
export { UI_KEYS } from './i18n-keys';
export type { ListUrl } from './list-url';
export { listUrl } from './list-url';
export { liveWindow } from './live-window';
export { TREE_ITEM_SELECTOR } from './roving';
export { ambientUiContext } from './theme/ambient';
export type { Brand } from './theme/brand';
export { brandStyleCspSource, brandStyleTag, defineTheme } from './theme/brand';
export type { Direction } from './theme/context';
export { fallbackTranslator, useUi } from './theme/context';
export { INERT_SOLID_RUNTIME } from './theme/inert-runtime';
export type { UiProviderProps } from './theme/provider';
export { UiProvider } from './theme/provider';
// The slot is its own module so that registering a runtime does not drag `errors.ts` — and with it
// @ultimat3/core's error registry — into an island chunk. `scripts/ui-barrel-bytes.test.ts` holds the ceiling.
export { setSolidRuntime } from './theme/runtime-slot';
export type { Accessor, SolidRuntime } from './theme/solid-adapter';
export { solid } from './theme/solid-adapter';
export type { ThemeEnv } from './theme/theme';
// --- theme -------------------------------------------------------------------
export {
  browserThemeEnv,
  clearTheme,
  defaultTheme,
  initTheme,
  resolveTheme,
  setTheme,
  THEME_ATTRIBUTE,
  THEME_DEFAULT_ATTRIBUTE,
  THEME_MEDIA_QUERY,
  toggleTheme,
  watchOsTheme,
} from './theme/theme';
export type { TimeRangeUrl } from './time-range-url';
export { timeRangeUrl } from './time-range-url';
export type { ToastAction, ToastDwell, ToastHold } from './toast/toast-state';
// --- toasts: the queue behind ToastRegion ------------------------------------
export { TOAST_DWELL_MS, TOAST_MAX_VISIBLE } from './toast/toast-state';
export type { ToastEnv, ToastStore } from './toast/toast-store';
export { INERT_TOAST_ENV, toastStore } from './toast/toast-store';
export { useToasts } from './toast/use-toasts';
export type { ColourVision } from './tokens/colour-vision';
export type { Channels } from './tokens/contrast';
export { AA_LARGE, AA_TEXT, contrastRatio, roleContrast } from './tokens/contrast';
export { CONTRAST_PAIRS } from './tokens/contrast-pairs';
export type { ColorRole, RadiusName, ShadowName, Theme } from './tokens/tokens';
// --- tokens ------------------------------------------------------------------
export { COLOR_ROLES, color, colorRgb, colorTokens, colorVar } from './tokens/tokens';
export { uiCatalog } from './ui-catalog';
export { registerHotkeys, useHotkeys } from './use-hotkeys';
