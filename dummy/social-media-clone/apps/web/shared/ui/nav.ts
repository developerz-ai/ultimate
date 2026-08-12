// The header's navigation model and the one rule that decides which item is current. Pure data and
// pure functions, so `aria-current` is testable without a renderer — and so the signed-out and the
// signed-in headers can never drift into two hand-written lists of links.

import type { IconGlyph } from '@ultimat3/ui';
import { iconBell } from '@ultimat3/ui/icons/bell';
import { iconLayoutDashboard } from '@ultimat3/ui/icons/layout-dashboard';
import { iconMessageSquare } from '@ultimat3/ui/icons/message-square';
import { iconRss } from '@ultimat3/ui/icons/rss';
import { iconShieldCheck } from '@ultimat3/ui/icons/shield-check';
import { iconUsers } from '@ultimat3/ui/icons/users';

export interface NavItem {
  /**
   * The catalog key's last segment: the header renders `t(\`nav.${name}\`)`. A template literal
   * rather than a stored key string because that is what `x i18n check` can see — a bare variable
   * makes every one of these keys read as unused, and unused is what an agent deletes.
   */
  readonly name: string;
  readonly href: string;
  readonly glyph: IconGlyph;
}

/** The public feed is the one destination an anonymous reader has, and it stays first when signed in. */
const FEED: NavItem = { name: 'feed', href: '/feed', glyph: iconRss };

const PRIVATE: readonly NavItem[] = [
  { name: 'dashboard', href: '/dashboard', glyph: iconLayoutDashboard },
  { name: 'friends', href: '/friends', glyph: iconUsers },
  { name: 'messages', href: '/messages', glyph: iconMessageSquare },
  { name: 'notifications', href: '/notifications', glyph: iconBell },
];

/**
 * The dashboard is a separate surface (`apps/admin`) mounted at `/admin`, so nothing in the web
 * app's own route table links it. It answered 200 for the seeded operator the whole time and was
 * reachable only by typing the URL — a screen nobody can find is a screen that does not exist.
 */
const ADMIN: NavItem = { name: 'admin', href: '/admin', glyph: iconShieldCheck };

/**
 * What the header offers this viewer. A signed-out visitor is shown only what they can actually
 * open: every private entry sits behind a route `policy`, and rendering one anyway would be a link
 * whose only outcome is a 303 back to sign-in.
 *
 * `operator` is asked as `admin:read` (see `viewer.ts`), the same grant the dashboard's own route
 * gates on — so this list can never offer a door that the door refuses.
 */
export const navFor = (signedIn: boolean, operator = false): readonly NavItem[] =>
  signedIn ? [FEED, ...PRIVATE, ...(operator ? [ADMIN] : [])] : [FEED];

export interface FooterLink {
  readonly name: string;
  readonly href: string;
}

const PUBLIC_LINKS: readonly FooterLink[] = [
  { name: 'feed', href: '/feed' },
  { name: 'signIn', href: '/signin' },
  { name: 'signUp', href: '/signup' },
];

const SIGNED_IN_LINKS: readonly FooterLink[] = [
  { name: 'feed', href: '/feed' },
  { name: 'dashboard', href: '/dashboard' },
];

/**
 * The footer's links, which are not the header's. Offering "Sign in" and "Create account" to
 * somebody who is already signed in is the small wrongness that tells a reader nothing on the page
 * knows who they are.
 */
export const footerLinksFor = (signedIn: boolean): readonly FooterLink[] =>
  signedIn ? SIGNED_IN_LINKS : PUBLIC_LINKS;

/**
 * Prefix match, on segment boundaries only. `/messages/<id>` must mark "Messages" current — a
 * reader deep in a thread has not left the section — while a future `/messages-archive` must not.
 */
export function isCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The path alone: `props.url` is absolute, and only the path decides what is current. */
export function pathnameOf(url: string | undefined): string {
  if (url === undefined) return '/';
  try {
    return new URL(url).pathname;
  } catch {
    // A relative value is already a path — accepted rather than thrown on, because a header that
    // takes the render down is worse than a header with nothing marked current.
    return url.startsWith('/') ? url : '/';
  }
}
