// One date formatter for the friends screen. Every call names an explicit IANA zone, because there
// is no ambient default anywhere in this app — a server formatting in its own zone tells a reader
// in another one the wrong day.

import { currentLocale } from '@ultimat3/i18n';

export const day = (value: Date, timeZone = 'UTC'): string =>
  new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeZone }).format(value);
