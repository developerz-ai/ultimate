// Single responsibility: an SES v2 error response → the retry verdict and the `fix:` line. SES
// names its failure in a TYPE (`x-amzn-ErrorType`, or `__type` in the body) far more precisely than
// its status does — `MessageRejected`, `SendingPausedException` and a bad request are all 400 — so
// the type decides, and core's status table answers only for a type this table does not know.

import { isRetryableStatus } from '@ultimat3/core';

/** What the driver needs to build `sendFailed(...)`: the verdict, the fix, and the text to show. */
export interface SesFailure {
  readonly type: string | undefined;
  readonly retryable: boolean;
  readonly fix: string;
  readonly detail: string;
}

type SesClass =
  | 'throttled'
  | 'rejected'
  | 'invalid'
  | 'paused'
  | 'unverified'
  | 'credentials'
  | 'missing';

/** Every SES (v1 and v2 spellings) and AWS-auth type this driver distinguishes. */
const CLASS_OF: ReadonlyMap<string, SesClass> = new Map([
  ['TooManyRequestsException', 'throttled'],
  ['ThrottlingException', 'throttled'],
  ['Throttling', 'throttled'],
  ['LimitExceededException', 'throttled'],
  ['MessageRejected', 'rejected'],
  ['BadRequestException', 'invalid'],
  ['SendingPausedException', 'paused'],
  ['AccountSendingPausedException', 'paused'],
  ['AccountSuspendedException', 'paused'],
  ['MailFromDomainNotVerifiedException', 'unverified'],
  ['UnrecognizedClientException', 'credentials'],
  ['InvalidClientTokenId', 'credentials'],
  ['InvalidSignatureException', 'credentials'],
  ['SignatureDoesNotMatch', 'credentials'],
  ['IncompleteSignature', 'credentials'],
  ['MissingAuthenticationToken', 'credentials'],
  ['ExpiredTokenException', 'credentials'],
  ['ExpiredToken', 'credentials'],
  ['AccessDeniedException', 'credentials'],
  ['AccessDenied', 'credentials'],
  ['NotFoundException', 'missing'],
]);

/** Only throttling clears by waiting; every other class is the same answer on the next attempt. */
const RETRYABLE: ReadonlySet<SesClass> = new Set<SesClass>(['throttled']);

const MAX_DETAIL_LENGTH = 200;

function fixFor(kind: SesClass | undefined, region: string): string {
  switch (kind) {
    case 'throttled':
      return `aws sesv2 get-account --region ${region} — the job already retries with backoff; raise the quota if this repeats`;
    case 'rejected':
      return `aws sesv2 get-email-identity --region ${region} --email-identity <your sending domain> — verify the From identity, and read SES's reason in the cause`;
    case 'paused':
      return `aws sesv2 put-account-sending-attributes --region ${region} --sending-enabled — after fixing why SES paused sending (aws sesv2 get-account)`;
    case 'unverified':
      return `aws sesv2 get-email-identity --region ${region} --email-identity <your sending domain> — publish the custom MAIL FROM domain's MX and SPF records it lists`;
    case 'credentials':
      return 'aws sts get-caller-identity — then set SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY to a key allowed ses:SendEmail, and sync this host clock if SES said the signature expired';
    case 'missing':
      return `aws sesv2 list-configuration-sets --region ${region} — create the set SES_CONFIGURATION_SET names, or unset it`;
    default:
      return 'curl -sS https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html — check the request against the SendEmail reference';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `MessageRejected:http://internal.amazon.com/…` or `com.amazonaws.ses#MessageRejected` → the name. */
function typeName(raw: string): string | undefined {
  const name = (raw.split(':')[0] ?? '').split('#').pop()?.trim() ?? '';
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : undefined;
}

function bodyField(body: unknown, ...keys: readonly string[]): string | undefined {
  if (!isRecord(body)) return undefined;
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Reads the response once; a body that is not JSON still yields a capped, printable detail. */
export async function sesFailure(response: Response, region: string): Promise<SesFailure> {
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const header = response.headers.get('x-amzn-errortype');
  const raw = header ?? bodyField(body, '__type', 'code', 'Code');
  const type = raw === undefined ? undefined : typeName(raw);
  const kind = type === undefined ? undefined : CLASS_OF.get(type);
  const message = bodyField(body, 'message', 'Message') ?? (text === '' ? 'an empty body' : text);
  const said = `${type ?? `HTTP ${response.status}`}: ${message}`;
  return {
    type,
    retryable: kind === undefined ? isRetryableStatus(response.status) : RETRYABLE.has(kind),
    fix: fixFor(kind, region),
    detail: said.length > MAX_DETAIL_LENGTH ? `${said.slice(0, MAX_DETAIL_LENGTH)}…` : said,
  };
}
