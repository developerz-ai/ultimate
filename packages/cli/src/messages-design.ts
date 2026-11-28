// `x design research` and `x shot --against`: the CLI catalog rows (`messages.ts` composes them) and
// the default reference sources as data. Data only — `msg()` is the one lookup.

/**
 * What a reference's licence lets an app take from it. The framework's own rule is stricter than
 * any of them — ideas and techniques only, never copied code — so this is the floor a reader
 * starts from, never a permission: `mit-attribution` says what copying WOULD owe.
 */
export const LICENCE_POSTURES = ['ideas-only', 'mit-attribution', 'apache-notice'] as const;
export type LicencePosture = (typeof LICENCE_POSTURES)[number];

export interface DesignSource {
  readonly name: string;
  readonly url: string;
  /** Hosts this source is served from, exact. A reference on one of them carries its posture. */
  readonly hosts: readonly string[];
  readonly posture: LicencePosture;
  readonly why: string;
}

/**
 * The catalogues `x design research --list` names. `ideas-only` where the licence restricts reuse
 * or varies per component; a host that is on no row is `ideas-only` too, failing closed.
 */
export const DESIGN_SOURCES: readonly DesignSource[] = [
  {
    name: 'React Bits',
    url: 'https://reactbits.dev',
    hosts: ['reactbits.dev', 'www.reactbits.dev'],
    posture: 'ideas-only',
    why: 'MIT with the Commons Clause: watch the effect, never open the source',
  },
  {
    name: '21st.dev',
    url: 'https://21st.dev',
    hosts: ['21st.dev', 'www.21st.dev'],
    posture: 'ideas-only',
    why: 'a community registry: each component carries its own author and licence',
  },
  {
    name: 'Paper Shaders',
    url: 'https://shaders.paper.design',
    hosts: ['shaders.paper.design', 'paper.design'],
    posture: 'ideas-only',
    why: 'shader techniques to re-derive in @ultimat3/effects, not code to port',
  },
  {
    name: 'shaders.com',
    url: 'https://shaders.com',
    hosts: ['shaders.com', 'www.shaders.com'],
    posture: 'ideas-only',
    why: 'a commercial catalogue',
  },
  {
    name: 'reui',
    url: 'https://reui.io',
    hosts: ['reui.io', 'www.reui.io'],
    posture: 'mit-attribution',
    why: 'MIT',
  },
  {
    name: 'shadcn/ui',
    url: 'https://ui.shadcn.com',
    hosts: ['ui.shadcn.com'],
    posture: 'mit-attribution',
    why: 'MIT',
  },
  {
    name: 'Motion',
    url: 'https://motion.dev',
    hosts: ['motion.dev', 'www.motion.dev'],
    posture: 'mit-attribution',
    why: 'MIT; @ultimat3/ui/motion is the engine, Motion the reference for timing feel',
  },
];

/** The posture a reference URL is held to: its source's, else `ideas-only`. */
export function postureFor(url: string): {
  readonly source: string | null;
  readonly posture: LicencePosture;
} {
  const host = new URL(url).hostname.toLowerCase();
  const source = DESIGN_SOURCES.find((entry) => entry.hosts.includes(host));
  return source === undefined
    ? { source: null, posture: 'ideas-only' }
    : { source: source.name, posture: source.posture };
}

export const DESIGN_MESSAGES = {
  'cli.design.list': '{count} reference source(s) — every one is ideas only: never copy code',
  'cli.design.source': '  {name}  {url}  {posture} — {why}',
  'cli.design.summary':
    '{count} reference(s) researched into {out} — tokens.proposal.json is a defineTheme() argument',
  'cli.design.reference': '  {url} → {dir}',
  'cli.design.facts':
    '    {colors} colour cluster(s), {animations} animation(s), {refused} request(s) refused',
  'cli.design.unvalidated':
    '    colours left out of the proposal: @ultimat3/ui did not resolve here, so no contrast check could run',
  'cli.shot.against.summary':
    '{pairs} picture(s) compared with the reference — lowest similarity {similarity} at {pair}',
  'cli.shot.against.none': 'no picture was compared with the reference',
  'cli.shot.against.line': '  {pair}  similarity {similarity}  {diff}  ({summary})',
} as const;
