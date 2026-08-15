// Compile-time pins for the route's data seam and for island JSX. Source, not a `.test.ts`, on
// purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.
//
// `.tsx`, not `.ts`, since 1.2.0: half of what is pinned here is only decidable by writing the JSX
// an author writes. `jsxImportSource` is `solid-js` in `tsconfig.base.json` and in both tracked
// apps, so the `<ContactSales />` below is checked against the SAME `JSX.Element` a page is —
// which is the only way a regression to `IslandNode` fails a build rather than a reader's review.

import type { IslandComponent } from './island';
import { island } from './island';
import type { JsonValue } from './island-props';
import type { LoadRequirement, RouteContext, RouteData, RouteDefinition } from './route';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type BlogPost = { readonly post: { readonly title: string } };

/**
 * What makes `routeDataFor`'s no-`load` branch sound. `RouteContext` has to BE a `RouteData` —
 * an `interface` is not, because only an alias gets the implicit index signature, and declaring
 * it as one is what turned that branch's `as unknown as TData` into a checked narrowing.
 */
export type _ContextIsRouteData = Assert<RouteContext extends RouteData ? true : false>;

/**
 * A route that loads nothing still declares nothing extra. `LoadRequirement` collapses to
 * `unknown` for the default `TData`, so every route that shipped before `load` existed — and
 * every route that only reads `data.url` / `data.params` — keeps compiling untouched.
 */
export type _DefaultDataNeedsNoLoad = Assert<
  RouteDefinition extends RouteDefinition & LoadRequirement<RouteData> ? true : false
>;

/**
 * …and a `meta` reading a field the context cannot supply forces one. Pinned as the required
 * `load` key rather than "does not compile", because that is the exact thing the intersection
 * adds: without it, `defineRoute<BlogPost>({ meta: (c) => c.data.post.title })` type-checked and
 * rendered `undefined` in a `<title>`.
 */
export type _RicherDataRequiresALoad = Assert<
  undefined extends LoadRequirement<BlogPost>['load'] ? false : true
>;

type ContactModal = IslandComponent<readonly ['subject']>;
type ContactModalProps = Parameters<ContactModal>[0];

/**
 * The declared prop is required and typed, so the call site that forgets it does not compile.
 * `props: ['subject']` is the whole declaration — there is no second place to state the shape.
 */
export type _DeclaredPropIsRequired = Assert<
  ContactModalProps extends { readonly subject: JsonValue } ? true : false
>;

/**
 * An island's props are exactly what it declared. Anything else has no type here, which is what
 * makes `<Modal {…row} />` a compile error before it is the runtime error that names the column.
 */
export type _UndeclaredPropHasNoType = Assert<
  'passwordHash' extends keyof ContactModalProps ? false : true
>;

/**
 * The children are the server-rendered shell and never JSON: they stay `unknown`, so nothing in
 * the type system suggests a component or a handler could travel to the browser inside them.
 */
export type _ChildrenAreNotJson = Assert<
  ContactModalProps['children'] extends JsonValue | undefined ? false : true
>;

/** A value the browser could never receive is not a `JsonValue`, so the prop never type-checks. */
export type _AHandleIsNotJson = Assert<(() => void) extends JsonValue ? false : true>;

const ContactSales: ContactModal = island({
  src: './contact-sales.island.tsx',
  props: ['subject'],
});

/**
 * The pin that a `.ts` file cannot carry: an island used the way every author reaches for it.
 *
 * `island()` returned a plain object node until 1.2.0, and every `<ContactSales />` in an app was
 * TS2786 — "its return type 'IslandNode' is not a valid JSX element" — while `h(ContactSales, …)`
 * compiled, which is why the framework's own island tests never saw it. The configured
 * `JSX.Element` is `solid-js`'s, a type ALIAS and therefore unaugmentable, whose only
 * object-shaped member is `ArrayElement`. `IslandNode` is that array, and this function is what
 * says so in a form `tsc` reads.
 *
 * Not `: JSX.Element` — render must not import `solid-js`. `unknown` is enough: the error lands on
 * the element, never on the return.
 */
export function _IslandIsAJsxComponent(): unknown {
  return (
    <ContactSales subject="pricing">
      <p>the server-rendered shell</p>
    </ContactSales>
  );
}
