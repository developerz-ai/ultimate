// The one widget dispatch. List cells, detail rows, and form inputs all render through this
// switch, so money is a Money widget and a timestamp is a DateTime widget with a zone in
// every one of those places — there is no second place to get it wrong.

import { t } from '@ultimat3/i18n';
import { DateTime, Money, Select, TextArea, TextInput, Toggle } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminField } from './fields';
import { type WidgetContext, type WidgetProps, widgetProps } from './widget-value';

export interface WidgetInput {
  readonly field: AdminField;
  readonly value: unknown;
  readonly ctx: WidgetContext;
  /** `read` renders a value, `edit` renders a control. */
  readonly mode: 'read' | 'edit';
  readonly onInput?: (field: string, value: unknown) => void;
}

const emit = (input: WidgetInput, value: unknown): void => {
  input.onInput?.(input.field.name, value);
};

/** Read-mode rendering of already-guarded props. Never formats; the widgets do that. */
function readView(props: WidgetProps, field: AdminField): JSX.Element {
  switch (props.widget) {
    case 'money':
      return props.value === null ? (
        <span>{t('admin.value.empty')}</span>
      ) : (
        <Money value={props.value} />
      );
    case 'datetime':
      return props.value === null ? (
        <span>{t('admin.value.empty')}</span>
      ) : (
        <DateTime value={props.value} timeZone={props.timeZone} precision={props.precision} />
      );
    case 'checkbox':
      return <span>{t(props.value ? 'admin.value.true' : 'admin.value.false')}</span>;
    case 'select':
      return (
        <span>
          {props.value === null
            ? t('admin.value.empty')
            : t(`${field.labelKey}.option.${props.value}`)}
        </span>
      );
    case 'json-editor':
      return <pre class="x-admin-json">{props.value}</pre>;
    case 'reference':
      return props.value === null ? (
        <span>{t('admin.value.empty')}</span>
      ) : (
        <a href={`/${props.entity}s/${props.value}`}>{props.value}</a>
      );
    case 'upload':
      return props.value === null ? (
        <span>{t('admin.value.empty')}</span>
      ) : (
        <a href={props.value.url}>{props.value.name}</a>
      );
    default:
      return <span>{String(props.value ?? '')}</span>;
  }
}

function editView(props: WidgetProps, input: WidgetInput): JSX.Element {
  const disabled = input.field.readOnly;
  switch (props.widget) {
    case 'textarea':
      return (
        <TextArea
          name={props.field}
          value={props.value}
          disabled={disabled}
          onInput={(next: string) => emit(input, next)}
        />
      );
    case 'number-input':
      return (
        <TextInput
          name={props.field}
          type="number"
          value={props.value === null ? '' : String(props.value)}
          disabled={disabled}
          onInput={(next: string) => emit(input, next === '' ? null : Number(next))}
        />
      );
    case 'money':
      return (
        <Money
          value={props.value}
          editable={!disabled}
          onInput={(next: { minor: number; currency: string }) => emit(input, next)}
        />
      );
    case 'checkbox':
      return (
        <Toggle
          name={props.field}
          checked={props.value}
          disabled={disabled}
          onChange={(next: boolean) => emit(input, next)}
        />
      );
    case 'select':
      return (
        <Select
          name={props.field}
          value={props.value}
          disabled={disabled}
          options={props.options.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          onChange={(next: string) => emit(input, next)}
        />
      );
    case 'datetime':
      return (
        <DateTime
          value={props.value}
          timeZone={props.timeZone}
          precision={props.precision}
          editable={!disabled}
          // The zone picker is part of the widget: an operator editing a timestamp must
          // state which zone they typed it in.
          zonePicker
          onInput={(next: string) => emit(input, next)}
        />
      );
    case 'timezone-picker':
      return (
        <Select
          name={props.field}
          value={props.value}
          disabled={disabled}
          options={ianaZones().map((zone) => ({ value: zone, label: zone }))}
          onChange={(next: string) => emit(input, next)}
        />
      );
    case 'locale-picker':
      return (
        <Select
          name={props.field}
          value={props.value}
          disabled={disabled}
          options={locales().map((locale) => ({ value: locale, label: locale }))}
          onChange={(next: string) => emit(input, next)}
        />
      );
    case 'json-editor':
      return (
        <TextArea
          name={props.field}
          value={props.value}
          disabled={disabled}
          monospace
          onInput={(next: string) => emit(input, next)}
        />
      );
    default:
      return (
        <TextInput
          name={props.field}
          value={String(props.value ?? '')}
          disabled={disabled}
          onInput={(next: string) => emit(input, next)}
        />
      );
  }
}

/** `Intl.supportedValuesOf` is the runtime's own IANA list — never a bundled copy. */
function ianaZones(): readonly string[] {
  const intl = Intl as { supportedValuesOf?: (key: 'timeZone') => readonly string[] };
  return intl.supportedValuesOf?.('timeZone') ?? ['UTC'];
}

function locales(): readonly string[] {
  return ['en', 'es', 'de', 'fr', 'pt', 'ja'];
}

export function Widget(input: WidgetInput): JSX.Element {
  const props = widgetProps(input.field, input.value, input.ctx);
  return input.mode === 'read' ? readView(props, input.field) : editView(props, input);
}
