// The public surface of @ultimat3/ui. Explicit exports only — this list is the
// design system's contract, and anything not named here is internal.

// Ambient declarations are not reachable through imports, so a consuming app's
// program would never load them — every `*.module.scss` import in this package
// would be TS2307 there. The reference pulls the contract along with the entry.
/// <reference path="./scss.d.ts" />

export type { FocusTrap, Politeness, RovingOptions, RovingOrientation } from './a11y';
export {
  announce,
  ariaBool,
  createFocusTrap,
  createRovingTabindex,
  FOCUSABLE_SELECTOR,
  focusableWithin,
  nextRovingIndex,
  resetIdCounter,
  useId,
} from './a11y';
export type { AccordionItem, AccordionProps } from './components/Accordion';
// --- components --------------------------------------------------------------
export { Accordion } from './components/Accordion';
export type { AlertProps } from './components/Alert';
export { Alert } from './components/Alert';
export type { AppShellProps } from './components/AppShell';
export { AppShell } from './components/AppShell';
export type { AvatarProps } from './components/Avatar';
export { Avatar, initialsOf } from './components/Avatar';
export type { AccordionSection } from './components/accordion-view';
export { accordionOpenIds } from './components/accordion-view';
export type { ShellIds, ShellLandmark, ShellSlots } from './components/app-shell-view';
export { shellIds, shellLandmarks } from './components/app-shell-view';
export type { BadgeProps } from './components/Badge';
export { Badge } from './components/Badge';
export type { BreadcrumbItem, BreadcrumbProps } from './components/Breadcrumb';
export { Breadcrumb } from './components/Breadcrumb';
export type { ButtonProps } from './components/Button';
export { Button } from './components/Button';
export type { CardProps, Elevation } from './components/Card';
export { Card } from './components/Card';
export type { CheckboxProps } from './components/Checkbox';
export { Checkbox } from './components/Checkbox';
export type { ComboboxProps } from './components/Combobox';
export { Combobox } from './components/Combobox';
export type { ContainerProps, ContainerSize } from './components/Container';
export { Container } from './components/Container';
export type { ComboboxOption } from './components/combobox-filter';
export { COMBOBOX_LIMIT, filterOptions, normalizeQuery } from './components/combobox-filter';
export type { Column, DataTableProps } from './components/DataTable';
export { DataTable } from './components/DataTable';
export type { DateTimeProps } from './components/DateTime';
export { DateTime } from './components/DateTime';
export type { DialogProps } from './components/Dialog';
export { Dialog } from './components/Dialog';
export type { DividerProps } from './components/Divider';
export { Divider } from './components/Divider';
export type { DrawerProps, DrawerSide } from './components/Drawer';
export { Drawer } from './components/Drawer';
export type { DropzoneProps } from './components/Dropzone';
export { Dropzone } from './components/Dropzone';
export type {
  DateStyle,
  DateTimeFormatter,
  DateTimeView,
  DateTimeViewOptions,
  TimeInput,
} from './components/date-time-view';
export { dateTimeView, toDate, toInstant, toIsoInstant } from './components/date-time-view';
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
export type {
  FileCandidate,
  FileRejection,
  FileRejectionReason,
  FileSelection,
  FileSelectionLimits,
  FileTarget,
} from './components/file-input-view';
export {
  acceptMatches,
  adoptDroppedFiles,
  formatBytes,
  progressPercent,
  selectFiles,
} from './components/file-input-view';
export type { GridProps } from './components/Grid';
export { Grid } from './components/Grid';
export type { HeadingLevel, HeadingTag } from './components/heading-level';
export { HEADING_LEVELS, headingTag, nextHeadingLevel } from './components/heading-level';
export type { IconProps } from './components/Icon';
// --- icons: the glyphs themselves are per-icon modules, `@ultimat3/ui/icons/<name>` ---------
export { Icon } from './components/Icon';
export type { IconButtonProps } from './components/IconButton';
export { IconButton } from './components/IconButton';
export type { ImageProps } from './components/Image';
export { Image } from './components/Image';
export type { InfiniteScrollProps } from './components/InfiniteScroll';
export { InfiniteScroll } from './components/InfiniteScroll';
export type { InputProps, InputType } from './components/Input';
export { Input } from './components/Input';
export type { IconElement, IconGlyph, IconTag } from './components/icon-glyph';
export { ICON_TAGS, iconElements, isIconTag } from './components/icon-glyph';
export type { ImageBox, ImageLoadingHints, ImageVariant } from './components/image-source';
export { boxFor, loadingHints, srcsetFor } from './components/image-source';
export type { LoadMoreInput, LoadMoreState } from './components/infinite-scroll-view';
export { loadMoreState } from './components/infinite-scroll-view';
export type { LinkProps } from './components/Link';
export { Link } from './components/Link';
export type { LocaleSwitcherProps } from './components/LocaleSwitcher';
export { LocaleSwitcher, localeLabel } from './components/LocaleSwitcher';
export type { LinkTarget } from './components/link-target';
export { linkTarget } from './components/link-target';
export type { MenuItem, MenuProps } from './components/Menu';
export { Menu } from './components/Menu';
export type { MoneyProps } from './components/Money';
export { Money } from './components/Money';
export type { MoneyFormatter, MoneyInput, MoneyViewOptions } from './components/money-view';
// --- formatting cores (pure, renderer-free) ----------------------------------
export { moneyText, toMoney } from './components/money-view';
export type { PageHeaderProps } from './components/PageHeader';
export { PageHeader } from './components/PageHeader';
export type { PaginationProps } from './components/Pagination';
export { Pagination } from './components/Pagination';
export type { Placement, PopoverProps } from './components/Popover';
export { Popover } from './components/Popover';
export type { RadioOption, RadioProps } from './components/Radio';
export { Radio } from './components/Radio';
export type { RelativeTimeProps } from './components/RelativeTime';
export { RelativeTime } from './components/RelativeTime';
export type { RelativeTimeOptions } from './components/relative-time-view';
export { relativeTimeText } from './components/relative-time-view';
export type { SectionProps } from './components/Section';
export { Section } from './components/Section';
export type { SelectOption, SelectProps } from './components/Select';
export { Select } from './components/Select';
export type { SkeletonProps } from './components/Skeleton';
export { Skeleton } from './components/Skeleton';
export type { SpinnerProps } from './components/Spinner';
export { Spinner } from './components/Spinner';
export type { StackProps } from './components/Stack';
export { Stack } from './components/Stack';
export type { SwitchProps } from './components/Switch';
export { Switch } from './components/Switch';
export type { SortDirection, SortState } from './components/sort-state';
export { ariaSortFor, nextSortState } from './components/sort-state';
export type { TableProps } from './components/Table';
export { Table } from './components/Table';
export type { TabItem, TabsProps } from './components/Tabs';
export { Tabs } from './components/Tabs';
export type { TextProps, TextSize, TextTone, TextWeight } from './components/Text';
export { TEXT_TONES, Text } from './components/Text';
export type { TextareaProps } from './components/Textarea';
export { Textarea } from './components/Textarea';
export type { ThemeChoice, ThemeToggleProps } from './components/ThemeToggle';
export { ThemeToggle } from './components/ThemeToggle';
export type { ToastProps, ToastRegionProps } from './components/Toast';
export { Toast, ToastRegion } from './components/Toast';
export type { ToolbarProps } from './components/Toolbar';
export { Toolbar } from './components/Toolbar';
export type { TooltipProps } from './components/Tooltip';
export { Tooltip } from './components/Tooltip';
export type { Align, ButtonVariant, Size, SpaceStep, Tone } from './components/variants';
// --- variants ----------------------------------------------------------------
export { BUTTON_VARIANTS, SIZES, TONES } from './components/variants';
export type { ClassValue } from './cx';
// --- helpers -----------------------------------------------------------------
export { cx } from './cx';
export type { Debounced } from './debounce';
export { DEBOUNCE_DEFAULT_MS, debounce } from './debounce';
export type { UiErrorCode } from './errors';
export {
  invalidBrandTokenError,
  invalidGlyphError,
  invalidIconDataError,
  invalidThemeError,
  invalidValueError,
  providerNeedsRuntimeError,
  runtimeMissingError,
  UI_ERROR_CODES,
  UiError,
  unknownTokenError,
} from './errors';
export type { UiKey } from './i18n-keys';
export { UI_KEYS } from './i18n-keys';
export type { ArrowKeyElement, RovingItem } from './roving';
export {
  handlesOwnArrowKeys,
  MENU_ITEM_SELECTOR,
  TAB_SELECTOR,
  tabStopIndex,
} from './roving';
export type { Brand, BrandInput, FontSlot } from './theme/brand';
export { brandStyleCspSource, brandStyleTag, defineTheme, FONT_SLOTS } from './theme/brand';
export type { Direction, UiContextValue } from './theme/context';
export {
  ambientUiContext,
  defaultUiContext,
  fallbackTranslator,
  UI_DEFAULT_CURRENCY,
  UI_DEFAULT_LOCALE,
  UI_DEFAULT_TIME_ZONE,
  uiContext,
  useUi,
} from './theme/context';
export { INERT_SOLID_RUNTIME } from './theme/inert-runtime';
export {
  THEME_INLINE_SCRIPT,
  themeInlineScriptCspSource,
  themeInlineScriptHash,
  themeInlineScriptTag,
} from './theme/inline-script';
export type { UiProviderProps } from './theme/provider';
export { UiProvider } from './theme/provider';
// The slot is its own module so that registering a runtime does not drag `errors.ts` — and with it
// @ultimat3/core's error registry — into an island chunk. `barrel-bytes.test.ts` holds the ceiling.
export { clearSolidRuntime, hasSolidRuntime, setSolidRuntime } from './theme/runtime-slot';
export type { Accessor, Setter, SolidContext, SolidRuntime } from './theme/solid-adapter';
export { solid } from './theme/solid-adapter';
export type { ThemeEnv } from './theme/theme';
// --- theme -------------------------------------------------------------------
export {
  browserThemeEnv,
  clearTheme,
  initTheme,
  isTheme,
  osTheme,
  resolveTheme,
  setTheme,
  storedTheme,
  THEME_ATTRIBUTE,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  toggleTheme,
  watchOsTheme,
} from './theme/theme';
export type { Channels } from './tokens/contrast';
export {
  AA_LARGE,
  AA_TEXT,
  CHANNELS_PATTERN,
  contrastRatio,
  meetsContrast,
  parseChannels,
  relativeLuminance,
  roleContrast,
} from './tokens/contrast';
export type { ColorRole, RadiusName, Theme } from './tokens/tokens';
// --- tokens ------------------------------------------------------------------
export {
  assertColorRole,
  breakpointTokens,
  COLOR_ROLES,
  color,
  colorRgb,
  colorTokens,
  colorVar,
  durationTokens,
  easingTokens,
  fontSizeTokens,
  fontWeightTokens,
  lineHeightTokens,
  radiusTokens,
  shadowTokens,
  spaceTokens,
  zTokens,
} from './tokens/tokens';
