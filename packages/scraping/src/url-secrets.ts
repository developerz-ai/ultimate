// What a URL that carries a credential may say about itself, and what it must hand the run's
// secret set. A proxy URL holds its password in the userinfo; a provider's CDP connect URL holds
// its access token in the query or the path. Both are named in errors and both pass through text
// this package persists, so the split is made once, here.

/**
 * Scheme and host — `wss://connect.provider.test:443` — and nothing a credential can live in: no
 * userinfo, no path, no query. A string that is not a URL answers a fixed phrase rather than
 * itself, because the caller is about to print the answer.
 */
export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'an endpoint that is not a URL';
  }
}

/** A lone `%` survives `URL` parsing and makes `decodeURIComponent` throw; the raw text is the answer then. */
const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** True when the userinfo carries anything — the half `--proxy-server` cannot be handed. */
export function hasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** `http://user:pass@exit:8080` → `http://exit:8080` plus the pair, decoded as the proxy expects. */
export function splitCredentials(url: string): {
  readonly bare: string;
  readonly username: string;
  readonly password: string;
} {
  const parsed = new URL(url);
  const username = decoded(parsed.username);
  const password = decoded(parsed.password);
  parsed.username = '';
  parsed.password = '';
  // `URL` renders a trailing slash for an empty path; a proxy argument never had one.
  return { bare: parsed.toString().replace(/\/$/, ''), username, password };
}

/**
 * The words that name a credential, matched against a query key's COMPONENTS — split on `_`, `-`,
 * `.` and camelCase — never as substrings: `keyboard` holds `key` and `monkey` holds it too, and
 * concealing their values blanked ordinary words out of every artifact. Read off the key and not
 * the value, because a provider's token can be short and the key is the URL's own statement.
 */
const CREDENTIAL_WORDS = new Set([
  'token',
  'key',
  'apikey',
  'secret',
  'auth',
  'authorization',
  'sig',
  'signature',
  'pass',
  'password',
  'passwd',
  'pwd',
  'cred',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'sid',
  'jwt',
  'bearer',
]);

const credentialKey = (key: string): boolean =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .some((part) => CREDENTIAL_WORDS.has(part));

/**
 * A value that is a capability whatever it is called: long, one unbroken run, letters and digits
 * mixed — a browser id, an access token. A word (`residential`, `true`, `eu`) is none of those.
 */
const credentialShaped = (value: string): boolean =>
  value.length >= 16 && !/\s/.test(value) && /[0-9]/.test(value) && /[a-z]/i.test(value);

/**
 * Every value in the URL that is, or may be, a credential — for the run's redaction set.
 *
 * The whole URL first, then the parts a message quotes on their own: a launcher's error says
 * `401 for /devtools/browser/<id>?token=…` as readily as it repeats the URL. Encoded and decoded
 * forms both, since a message may carry either. The host is left out on purpose: it is what an
 * error is allowed to say.
 *
 * A query VALUE or a path SEGMENT only when it is credential-shaped or sits under a
 * credential-named key — never every value. Concealing `stealth=true&proxy=residential` blanked
 * every `true` and `residential` in the page, the console and the network ring of the run: the
 * unreadable artifact `MIN_REDACTABLE_LENGTH` exists to prevent.
 */
export function urlSecretValues(url: string): readonly string[] {
  const values = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    // The password and not the username: a proxy username is an account and a zone, and redacting
    // `admin` by value would blank the word out of every page artifact.
    values.add(parsed.password);
    values.add(decoded(parsed.password));
    if (parsed.search !== '') {
      values.add(`${parsed.pathname}${parsed.search}`);
      values.add(parsed.search.slice(1));
    }
    const segments = parsed.pathname.split('/');
    for (const [index, segment] of segments.entries()) {
      // By POSITION as well as by shape: Chrome's `/devtools/<browser|page>/<id>` id IS the
      // capability, and an id of letters alone is not credential-shaped.
      const capability = index >= 2 && segments[index - 2] === 'devtools';
      if (capability || credentialShaped(decoded(segment))) {
        values.add(decoded(segment)).add(segment);
      }
    }
    for (const [key, value] of parsed.searchParams) {
      if (credentialKey(key) || credentialShaped(value)) values.add(value);
    }
  } catch {
    // Not a URL: the whole string above is all there is to redact.
  }
  values.delete('');
  return [...values];
}
