// Single responsibility: which kind of network an IP address literal belongs to. Tier 0 because the
// SSRF screens that need it sit in packages that may not import each other — `@ultimat3/jobs`'
// webhook delivery (tier 3) and `@ultimat3/scraping` (tier 5) — and a copy per screen is how one
// of them comes to miss `::ffff:127.0.0.1`.

/**
 * `reserved` is every range that is neither a host network nor public: multicast, broadcast,
 * `240.0.0.0/4`, the documentation and benchmarking nets. A screen allowing only `public` refuses
 * all of them, which is the point of naming them rather than calling them public.
 */
export type AddressClass =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'ula'
  | 'cgnat'
  | 'unspecified'
  | 'reserved'
  | 'public';

/** `[network, prefixBits]` over the 32-bit value; ordered, first match wins. */
const V4_RULES: readonly (readonly [number, number, AddressClass])[] = [
  [0x00000000, 8, 'unspecified'],
  [0x7f000000, 8, 'loopback'],
  [0x0a000000, 8, 'private'],
  [0xac100000, 12, 'private'],
  [0xc0a80000, 16, 'private'],
  [0xa9fe0000, 16, 'link-local'],
  [0x64400000, 10, 'cgnat'],
  [0xc0000000, 24, 'reserved'], // 192.0.0.0/24, IETF protocol assignments
  [0xc0000200, 24, 'reserved'], // 192.0.2.0/24, TEST-NET-1
  [0xc6120000, 15, 'reserved'], // 198.18.0.0/15, benchmarking
  [0xc6336400, 24, 'reserved'], // 198.51.100.0/24, TEST-NET-2
  [0xcb007100, 24, 'reserved'], // 203.0.113.0/24, TEST-NET-3
  [0xe0000000, 4, 'reserved'], // multicast
  [0xf0000000, 4, 'reserved'], // 240.0.0.0/4 and the broadcast address inside it
];

/**
 * Strict dotted quad: four decimal octets, no leading zero. `010.0.0.1` is octal to some parsers
 * and decimal to others, so it is not an address this module will vouch for — a screen that
 * refuses what it cannot classify is the only safe reader of it.
 */
function parseV4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function classifyV4(value: number): AddressClass {
  for (const [network, bits, kind] of V4_RULES) {
    const size = 2 ** (32 - bits);
    if (value >= network && value < network + size) return kind;
  }
  return 'public';
}

/** Eight 16-bit groups, or `undefined`. A trailing dotted quad fills the last two. */
function parseV6(text: string): readonly number[] | undefined {
  let body = text;
  let tail: number[] = [];
  const lastColon = body.lastIndexOf(':');
  if (body.includes('.', lastColon)) {
    const v4 = parseV4(body.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 0x10000), v4 % 0x10000];
    // `::ffff:1.2.3.4` keeps `::ffff`; `::1.2.3.4` keeps its `::`, the one colon that is syntax.
    const head = body.slice(0, lastColon + 1);
    body = head.endsWith('::') ? head : head.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string): number[] | undefined => {
    if (half === '') return [];
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (head === undefined || rest === undefined) return undefined;
  const width = head.length + rest.length + tail.length;
  if (halves.length === 1) return width === 8 ? [...head, ...tail] : undefined;
  if (width > 7) return undefined;
  return [...head, ...new Array<number>(8 - width).fill(0), ...rest, ...tail];
}

const embeddedV4 = (g: readonly number[]): number => (g[6] ?? 0) * 0x10000 + (g[7] ?? 0);

function classifyV6(g: readonly number[]): AddressClass {
  const zeroUpTo = (n: number): boolean => g.slice(0, n).every((group) => group === 0);
  if (zeroUpTo(8)) return 'unspecified';
  if (zeroUpTo(7) && g[7] === 1) return 'loopback';
  // IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d` and NAT64 `64:ff9b::/96`: each is
  // routed to the IPv4 address it carries, so that address is what gets classified.
  if (zeroUpTo(5) && g[5] === 0xffff) return classifyV4(embeddedV4(g));
  if (zeroUpTo(6)) return classifyV4(embeddedV4(g));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) {
    return classifyV4(embeddedV4(g));
  }
  const first = g[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local
  if ((first & 0xfe00) === 0xfc00) return 'ula';
  if ((first & 0xff00) === 0xff00) return 'reserved'; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return 'reserved'; // documentation
  if (first === 0x0100 && g.slice(1, 4).every((group) => group === 0)) return 'reserved'; // 100::/64

  return 'public';
}

/**
 * The class of an IP address LITERAL — IPv4, IPv6, bracketed `[::1]`, a zone id `fe80::1%eth0`,
 * and every IPv6 form carrying an IPv4 address. `undefined` means "not an address literal": a
 * hostname must be resolved first and each resolved address classified, never this string.
 */
export function classifyAddress(address: string): AddressClass | undefined {
  let text = address.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1 && text.includes(':')) text = text.slice(0, zone);
  if (text.includes(':')) {
    const groups = parseV6(text);
    return groups === undefined ? undefined : classifyV6(groups);
  }
  const v4 = parseV4(text);
  return v4 === undefined ? undefined : classifyV4(v4);
}

/** Fails CLOSED: anything but a literal classified `public` — a hostname included — is `false`. */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}
