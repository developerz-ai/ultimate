// Single responsibility: what a repro bundle may say about the MACHINE it was made on. The app root,
// the home directory, every env value (the process's and the app's dotenv files') and every hostname
// the config or an env URL names are replaced by a token; a frame's absolute path is made relative.

import { isRedactedKey } from '@ultimat3/core';

export interface ScrubSources {
  /** The app root, absolute. Becomes `.`. */
  readonly root: string;
  /** Every spelling of the home directory known here. Each becomes `~`. */
  readonly homes: readonly string[];
  /** The env values to hide, by name: the process env and every dotenv file's, duplicates kept. */
  readonly env: readonly (readonly [name: string, value: string | undefined])[];
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
}

/** Shorter than this, a value is a flag (`true`, `3000`) that would match everywhere and hide nothing. */
const MIN_ENV_VALUE = 6;
/** A secret-NAMED var hides from this length: a four-digit PIN is still a credential. */
const MIN_SECRET_VALUE = 3;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** The hostname inside an env value or config string that is a URL or a DSN, else `undefined`. */
export function hostOf(text: string): string | undefined {
  if (!text.includes('://')) return undefined;
  try {
    const host = new URL(text.trim()).hostname.toLowerCase();
    return host === '' || LOOPBACK.has(host) ? undefined : host;
  } catch {
    return undefined;
  }
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
  for (const [name, value] of sources.env) {
    if (value === undefined) continue;
    const host = hostOf(value);
    if (host !== undefined) hosts.add(host);
    const min = isRedactedKey(name) ? MIN_SECRET_VALUE : MIN_ENV_VALUE;
    if (value.trim().length >= min)
      values.push({ find: value, replace: `[env:${name}]`, env: name });
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

export function scrubberFor(sources: ScrubSources): Scrubber {
  const { paths, values } = needlesOf(sources);
  const hitEnv = new Set<string>();
  const hitHosts = new Set<string>();
  const text = (input: string): string => {
    let out = input;
    for (const needle of paths) out = out.replaceAll(needle.find, needle.replace);
    for (const needle of values) {
      // A host is a whole name: the machine called `box` must not turn `checkbox` into `check[host]`.
      const pattern =
        needle.host === true
          ? new RegExp(`(?<![\\w.-])${literal(needle.find)}(?![\\w-])`, 'gi')
          : new RegExp(literal(needle.find), 'g');
      if (!pattern.test(out)) continue;
      out = out.replace(pattern, needle.replace);
      if (needle.env !== undefined) hitEnv.add(needle.env);
      if (needle.host === true) hitHosts.add(needle.find);
    }
    return out;
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
