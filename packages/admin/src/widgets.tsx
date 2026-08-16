// The one widget dispatch. List cells, detail rows, and form inputs all render through this
// switch, so money is a Money widget and a timestamp is a DateTime widget with a zone in
// every one of those places — there is no second place to get it wrong.

import { safeUrl } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import {
  Checkbox,
  DateTime,
  type DateTimeFormatter,
  type FieldControl,
  Input,
  Money,
  Select,
  Textarea,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminField } from './fields';
import { type WidgetContext, type WidgetProps, widgetProps } from './widget-value';

export interface WidgetInput {
  readonly field: AdminField;
  readonly value: unknown;
  readonly ctx: WidgetContext;
  /** `read` renders a value, `edit` renders a control. */
  readonly mode: 'read' | 'edit';
  /** Id and description wiring from the surrounding `<Field>`, when there is one. */
  readonly control?: FieldControl;
  readonly onInput?: (field: string, value: unknown) => void;
}

const emit = (input: WidgetInput, value: unknown): void => {
  input.onInput?.(input.field.name, value);
};

/** The part of a `FieldControl` every ui control accepts. Empty when rendered bare. */
interface ControlWiring {
  readonly id?: string | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly required?: boolean | undefined;
}

const wiring = (control: FieldControl | undefined): ControlWiring =>
  control === undefined
    ? {}
    : {
        id: control.id,
        'aria-describedby': control['aria-describedby'],
        'aria-invalid': control['aria-invalid'],
        required: control.required,
      };

/**
 * A `date` column has no time of day, and ui's default formatter always renders one. A
 * rendered midnight is wrong in every zone but the one the value was stored in.
 */
const dateOnly: DateTimeFormatter = (at, options) =>
  new Intl.DateTimeFormat(options.locale, {
    timeZone: options.zone,
    dateStyle: 'medium',
  }).format(at);

/** `<input type="date">` wants `YYYY-MM-DD`; `datetime-local` wants `YYYY-MM-DDTHH:mm`. */
const inputValueFor = (iso: string, precision: 'date' | 'instant'): string =>
  iso.slice(0, precision === 'date' ? 10 : 16);

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
        <DateTime
          value={props.value}
          timeZone={props.timeZone}
          format={props.precision === 'date' ? dateOnly : undefined}
        />
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
        <a href={safeUrl(props.value.url, 'href') ?? undefined}>{props.value.name}</a>
      );
    default:
      return <span>{String(props.value ?? '')}</span>;
  }
}

function editView(props: WidgetProps, input: WidgetInput): JSX.Element {
  const disabled = input.field.readOnly;
  const shared = wiring(input.control);
  switch (props.widget) {
    case 'textarea':
      return (
        <Textarea
          {...shared}
          name={props.field}
          value={props.value}
          disabled={disabled}
          onInput={(event) => emit(input, event.currentTarget.value)}
        />
      );
    case 'number-input':
      // `inputmode` on a text field, never `type="number"`: a locale decimal separator has to
      // survive the round trip, and the entity's schema is what decides it is a number.
      return (
        <Input
          {...shared}
          name={props.field}
          inputmode="decimal"
          value={props.value === null ? '' : String(props.value)}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            emit(input, next === '' ? null : Number(next));
          }}
        />
      );
    case 'money': {
      // Minor units, not a decimal: turning "12,34" into cents is currency- and locale-aware
      // work owned by @ultimat3/money, and the design system has no money input to host it.
      const currency = props.value?.currency ?? input.field.currency ?? '';
      return (
        <Input
          {...shared}
          name={props.field}
          inputmode="numeric"
          value={props.value === null ? '' : String(props.value.minor)}
          suffix={currency}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            emit(input, next === '' ? null : { minor: Number(next), currency });
          }}
        />
      );
    }
    case 'checkbox':
      return (
        <Checkbox
          {...shared}
          label={t(input.field.labelKey)}
          name={props.field}
          checked={props.value}
          disabled={disabled}
          onChange={(event) => emit(input, event.currentTarget.checked)}
        />
      );
    case 'select':
      return (
        <Select
          {...shared}
          name={props.field}
          value={props.value ?? ''}
          disabled={disabled}
          options={props.options.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          onChange={(event) => emit(input, event.currentTarget.value)}
        />
      );
    case 'datetime':
      // The stored value is the UTC instant, so the control edits UTC and says so beside the
      // box: an operator editing a timestamp must know which zone they typed it in.
      return (
        <Input
          {...shared}
          name={props.field}
          type={props.precision === 'date' ? 'date' : 'datetime-local'}
          value={props.value === null ? '' : inputValueFor(props.value, props.precision)}
          suffix={props.precision === 'date' ? undefined : 'UTC'}
          disabled={disabled}
          onInput={(event) => emit(input, event.currentTarget.value)}
        />
      );
    case 'timezone-picker':
      return (
        <Select
          {...shared}
          name={props.field}
          value={props.value ?? ''}
          disabled={disabled}
          options={ianaZones().map((zone) => ({ value: zone, label: zone }))}
          onChange={(event) => emit(input, event.currentTarget.value)}
        />
      );
    case 'locale-picker':
      return (
        <Select
          {...shared}
          name={props.field}
          value={props.value ?? ''}
          disabled={disabled}
          options={locales().map((locale) => ({ value: locale, label: locale }))}
          onChange={(event) => emit(input, event.currentTarget.value)}
        />
      );
    case 'json-editor':
      return (
        <Textarea
          {...shared}
          class="x-admin-json"
          name={props.field}
          value={props.value}
          disabled={disabled}
          onInput={(event) => emit(input, event.currentTarget.value)}
        />
      );
    default:
      return (
        <Input
          {...shared}
          name={props.field}
          value={String(props.value ?? '')}
          disabled={disabled}
          onInput={(event) => emit(input, event.currentTarget.value)}
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
