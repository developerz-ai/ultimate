// Single responsibility: what a repro bundle may say about the MACHINE and the people on it. The app
// root, home, secret-named / URL / dotenv env values (and a URL's credentials in every encoding),
// config hostnames, any URL's userinfo and query values, emails and IPs become tokens; a frame's
// absolute path is made relative. A value it was never told about is NOT found: say so to the user.

import { isRedactedKey } from '@ultimat3/core';

export interface ScrubEnv {
  readonly name: string;
  readonly value: string | undefined;
  /** `process`: hidden only when secret-named or a URL. `dotenv`: an app file's, always hidden. */
  readonly from: 'process' | 'dotenv';
}

export interface ScrubSources {
  /** The app root, absolute. Becomes `.`. */
  readonly root: string;
  /** Every spelling of the home directory known here. Each becomes `~`. */
  readonly homes: readonly string[];
  readonly env: readonly ScrubEnv[];
  /** Hostnames named by the config (and the machine's own); each becomes `[host]`. */
  readonly hosts: readonly string[];
}

export interface ScrubReport {
  /** Names (never values) of the env vars whose value was found and replaced, sorted. */
  readonly env: readonly string[];
  /** How many distinct hostnames were found and replaced. */
  readonly hosts: number;
}

export interface Scrubber {
  /** Every string leaf and key of a JSON-safe value, scrubbed. */
  value(value: unknown): unknown;
  /** A cause or a stack frame: scrubbed, then any absolute path left made relative. */
  location(text: string): string;
  report(): ScrubReport;
}

interface Needle {
  readonly find: string;
  readonly replace: string;
  readonly env?: string;
  readonly host?: true;
  /** Matched as a whole token only: a URL's user `app` must not eat the `app` in `apps/`. */
  readonly word?: true;
}

/** Shorter than this, a dotenv value is a flag (`true`, `3000`) that would match everywhere. */
const MIN_ENV_VALUE = 6;
/** A secret-NAMED var, or a URL's credential, hides from this length: a PIN is still a credential. */
const MIN_SECRET_VALUE = 3;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

const parseUrl = (text: string): URL | undefined => {
  if (!text.includes('://')) return undefined;
  try {
    return new URL(text.trim());
  } catch {
    return undefined;
  }
};

/** The hostname inside an env value or config string that is a URL or a DSN, else `undefined`. */
export function hostOf(text: string): string | undefined {
  const host = parseUrl(text)?.hostname.toLowerCase();
  return host === undefined || host === '' || LOOPBACK.has(host) ? undefined : host;
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Every spelling a credential travels in: as written, URL-decoded, and base64 (a Basic header). */
function credentialSpellings(value: string): string[] {
  const url = parseUrl(value);
  if (url === undefined || (url.username === '' && url.password === '')) {
    return base64Of([value]);
  }
  const user = decoded(url.username);
  const pass = decoded(url.password);
  return [
    url.username,
    url.password,
    user,
    pass,
    ...base64Of([`${user}:${pass}`, `${url.username}:${url.password}`]),
  ];
}

/**
 * Base64 of each text's UTF-8 bytes — what a Basic header holds; `btoa` alone throws past Latin-1
 * (`pässwörd€`) and took `x repro --bundle` down with it. A spelling that cannot be built is
 * skipped, never the scrub.
 */
function base64Of(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    try {
      out.push(btoa(String.fromCharCode(...new TextEncoder().encode(text))));
    } catch {
      // One spelling fewer: the raw and decoded values are still needles.
    }
  }
  return out;
}

/** Both separators of a path, so a Windows root pasted either way is found. */
const spellings = (path: string): string[] =>
  [...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])].filter(
    (spelling) => spelling.length > 1,
  );

function needlesOf(sources: ScrubSources): { paths: Needle[]; values: Needle[] } {
  const paths = [
    ...spellings(sources.root).map((find) => ({ find, replace: '.' })),
    ...sources.homes.flatMap(spellings).map((find) => ({ find, replace: '~' })),
  ];
  const values: Needle[] = [];
  const hosts = new Set(sources.hosts.map((host) => host.toLowerCase()));
  for (const { name, value: raw, from } of sources.env) {
    // Trimmed first: a dotenv `TOKEN="abc\n"` is held by the app, and reaches a log, as `abc`.
    const value = raw?.trim();
    if (value === undefined || value === '') continue;
    const host = hostOf(value);
    if (host !== undefined) hosts.add(host);
    const secret = isRedactedKey(name);
    const hidden = secret || host !== undefined || from === 'dotenv';
    if (!hidden) continue;
    const min = secret ? MIN_SECRET_VALUE : MIN_ENV_VALUE;
    if (value.length >= min) values.push({ find: value, replace: `[env:${name}]`, env: name });
    if (!secret && host === undefined) continue;
    for (const find of credentialSpellings(value)) {
      if (find.length >= MIN_SECRET_VALUE) {
        values.push({ find, replace: `[env:${name}]`, env: name, word: true });
      }
    }
  }
  for (const host of hosts) {
    if (host.length > 2 && !LOOPBACK.has(host))
      values.push({ find: host, replace: '[host]', host: true });
  }
  // Longest first: a URL value is replaced whole before the host inside it is looked for.
  const longest = (a: Needle, b: Needle): number => b.find.length - a.find.length;
  return { paths: paths.sort(longest), values: values.sort(longest) };
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A URL in prose: its scheme, then everything up to a space, a quote or a bracket. */
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;
/** Any URL's userinfo and query VALUES: credentials and tokens ride in both. */
function withoutUrlSecrets(text: string): string {
  return text.replace(URL_TEXT, (url) =>
    url
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1[cred]@')
      .replace(/\?[^#]*/, (query) => query.replace(/=[^&]*/g, '=[redacted]')),
  );
}

const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/gi;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?![\\w.])`, 'g');
const H = '[0-9a-f]{1,4}';
/** Eight groups, or a `::` with a group on at least one side: never a clock time or `A::b` in a word. */
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,5})?|::${H}(?::${H}){0,6})(?![\\w:])`,
  'gi',
);

/** The first segment of a path that is the machine's, whatever its extension. */
const SYSTEM_ROOT =
  /^\/(?:home|Users|root|tmp|private|var|opt|usr|etc|srv|mnt|nix|snap|proc|run)\//;
/** An absolute POSIX path not glued to a word, a URL's `//`, or a token this file wrote. */
const POSIX_PATH = /(?<![\w.~\]:/>@-])\/(?:[^\s/():'"`,]+\/)*[^\s/():'"`,]+/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\():'"`,]+\\)*[^\s\\():'"`,]+/g;

/** A path that is the machine's: a known system root, or a file (its last segment has an extension). */
function relativePath(path: string, separator: '/' | '\\'): string {
  const segments = path.split(separator);
  const modules = segments.lastIndexOf('node_modules');
  if (modules >= 0) return segments.slice(modules).join('/');
  const last = segments.at(-1) ?? '';
  const isFile = /\.[A-Za-z0-9]+$/.test(last.replace(/(?::\d+)+$/, ''));
  if (separator === '/' && !isFile && !SYSTEM_ROOT.test(`${path}/`)) return path;
  return `<abs>/${last}`;
}

/**
 * A host is a whole name, and only where a host stands: `checkbox` keeps its `box`, and a host
 * after one `/` (a path segment, a package scope's tail) or after a bare `@` is not one. After a
 * URL's `//` or this file's own `[cred]@` it is.
 */
const hostPattern = (host: string): RegExp =>
  new RegExp(`(?<![\\w.-])(?<!(?:^|[^/])/)(?<!(?:^|[^\\]])@)${literal(host)}(?![\\w-])`, 'gi');

export function scrubberFor(sources: ScrubSources): Scrubber {
  const { paths, values } = needlesOf(sources);
  const hitEnv = new Set<string>();
  const hitHosts = new Set<string>();
  const replaceAll = (out: string, needles: readonly Needle[]): string => {
    let next = out;
    for (const needle of needles) {
      const pattern =
        needle.host === true
          ? hostPattern(needle.find)
          : needle.word === true
            ? new RegExp(`(?<![\\w%+-])${literal(needle.find)}(?![\\w%+-])`, 'g')
            : new RegExp(literal(needle.find), 'g');
      if (!pattern.test(next)) continue;
      next = next.replace(pattern, needle.replace);
      if (needle.env !== undefined) hitEnv.add(needle.env);
      if (needle.host === true) hitHosts.add(needle.find);
    }
    return next;
  };
  const envNeedles = values.filter((needle) => needle.host !== true);
  const hostNeedles = values.filter((needle) => needle.host === true);
  const text = (input: string): string => {
    let out = input;
    for (const needle of paths) out = out.replaceAll(needle.find, needle.replace);
    out = withoutUrlSecrets(replaceAll(out, envNeedles));
    return replaceAll(out, hostNeedles)
      .replace(EMAIL, '[email]')
      .replace(IPV4, '[ip]')
      .replace(IPV6, '[ip]');
  };
  const value = (input: unknown, depth = 0): unknown => {
    if (typeof input === 'string') return text(input);
    if (input === null || typeof input !== 'object') return input;
    if (depth > 32) return '[depth-limit]';
    if (Array.isArray(input)) return input.map((entry) => value(entry, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      // `defineProperty`: a key named `__proto__` in captured input must stay a key.
      Object.defineProperty(out, text(key), {
        value: value(entry, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return {
    value: (input) => value(input),
    location: (input) =>
      text(input.replaceAll('file://', ''))
        .replace(POSIX_PATH, (path) => relativePath(path, '/'))
        .replace(WINDOWS_PATH, (path) => relativePath(path, '\\')),
    report: () => ({ env: [...hitEnv].sort(), hosts: hitHosts.size }),
  };
}
