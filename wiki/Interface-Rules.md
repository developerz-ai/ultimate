# Interface rules

What a screen must do, as rules an agent can apply without judgement — and, where judgement is
unavoidable, marked as judgement so it is not mistaken for a check.

`As of 2026-09`.

**Read the second column before the first.** Every rule is one of two kinds:

| Column says | Means |
|---|---|
| a mechanism | a build error. The named guard, type or gate step refuses it. Break it and `x verify` is red |
| **judgement** | nothing checks it. It is here because an agent still has to follow it, and because axiom 3 says an unenforced convention does not exist — so this page says which ones do not |

The mechanisms are of three shapes, and knowing which one you hit tells you where the fix goes:

| Shape | Where it fires | Example |
|---|---|---|
| a **type** in `@ultimat3/ui` | `x verify`'s `typecheck` step | `AsyncRegionProps.empty` is required |
| a **guard** in your app's `guards/` | `x verify`'s `boundaries` step | `guards/focus-visible.ts` |
| a **test** in the framework | `x verify`'s `unit` step | `packages/ui/src/tokens/contrast.test.ts` |

Guards are yours: `x new` writes nine, the directory is the registration, and deleting a file
deletes the rule. Add one with `x g guard <name>`. Each raises an app-owned `X_*` code derived from
its own filename — `guards/focus-visible.ts` raises `X_FOCUS_VISIBLE` — so a finding says which
convention broke, not which framework subsystem noticed.

## Loading, empty, error

| Rule | Refused by |
|---|---|
| Every region that waits on data has four branches: pending, failed, empty, ready | `AsyncRegion` renders all four; a hand-rolled region is **judgement** |
| `empty` is unreachable while pending | the `AsyncBranch` union, `packages/ui/src/components/async-branch.ts` — `pending` carries no data, so nothing can be found empty in it |
| Declare what "nothing here" looks like | `AsyncRegionProps.empty` is a required prop with no default |
| A refetch keeps the previous data on screen | `asyncStateOf` — `loading` beside a defined `data` is `refreshing`, never `pending` |
| A failure beats stale data: report the error, do not re-render rows the failed request did not answer | `asyncBranch` tests `failed` first |
| Placeholder, error, empty and content land in the same box | `reserveBlockSize` is emitted as `--async-reserve` on the region in every branch |
| The region carries `aria-busy` while in flight | `AsyncRegion` derives it from `isBusyBranch` |
| `data: undefined` means nothing has arrived. An empty array is data | `asyncStateOf` |
| A `{ total: 0, items: [] }` envelope passes its own `isEmpty` — `isEmptyData` does not guess at an envelope | `AsyncRegionProps.isEmpty` |

Rendering "No results" for one frame before the first page arrives is the most common
agent-authored UX bug in a list screen. The union above is why it is unconstructible rather than
discouraged.

## Skeletons and spinners

| Rule | Refused by |
|---|---|
| A skeleton only where the shape is known, stable, and the wait is 1–3 seconds | **judgement** |
| The placeholder box equals the loaded box | `AsyncRegion` feeds one `reserve` to `Skeleton` and to the content box |
| A skeleton is never announced | `Skeleton` is `aria-hidden="true"`; the region's `aria-busy` is the announcement |
| A spinner has an accessible name | `Spinner` is `role="status"` with `aria-label`, defaulting to the `ui.loading` catalog key |
| A decorative spinner inside an already-announced region is hidden | `SpinnerProps.decorative` |
| Never a skeleton for an unknown-length list, a variable-height card, or content whose shape depends on the response | **judgement** |

**The evidence runs against skeletons, not for them.** A controlled study (Viget, n = 136,
durations matched between conditions) found a skeleton screen lost to a plain spinner on every
measure taken, perceived wait included — **2.82s** perceived under the skeleton against **2.41s**
under the spinner. Treat "use a skeleton" as a claim needing a reason, not a default. A skeleton
whose box does not match the loaded content is strictly worse than a spinner: it converts a
perception problem into a layout-shift problem, and layout shift is measured.

## Response tiers

Nielsen's three limits. All four rows are **judgement** — nothing in the gate times a response.

| Elapsed | Show |
|---|---|
| under 100ms | nothing. The result is the feedback. A spinner here reads as a stutter |
| under 1s | still nothing. Thought is unbroken; a spinner that appears and vanishes is noise |
| 1–10s | an indeterminate busy indicator. Keep the trigger visible and disabled, not replaced |
| over 10s | determinate progress **and** a cancel. Attention is gone at 10s; a bar with no cancel is a hostage |

Never a spinner on a control whose action completes locally. Never a determinate bar over a
percentage you are inventing.

## Optimistic UI

Correct only when **all three** hold: the operation is idempotent, its result is predictable from
the input alone, and it targets the same URL.

| Rule | Refused by |
|---|---|
| Never optimistic on money, a balance, stock, a quota, or a permission grant | **judgement** |
| The optimistic twin is a pure function of `(tx, input)` — no I/O, no `Date.now()`, no `Math.random()` | **judgement** in an app. `local` is replayed on every rebase, so an impure one diverges silently |
| The twin is convergent, not incremental: applying it N times equals applying it once | **judgement**. `likedByMe ? {} : { likeCount: n + 1 }` is the shape; `likeCount + 1` is the bug |
| Rollback is written, never assumed | the local store journals the first write per key and undoes newest-first — but only when a `LocalStore` is wired. Without one, nothing rolls back |
| A refused mutation is rolled back, not retried | `@ultimat3/realtime` drops the refused intent from the rebase log |

Full shape and the conflict strategies: [Realtime](Realtime#same-mutator-at-every-rung).

## Forms

| Rule | Refused by |
|---|---|
| A label is a real `<label for>`, never a placeholder and never an adjacent `<span>` | `FieldProps.label` is required, and `Field` renders `<label for={id}>` |
| `aria-describedby` and `aria-invalid` cannot drift from what is rendered | `Field` owns the ids and hands them to the control through `FieldControl` |
| Never block paste | `InputProps` declares no `onPaste` and `@ultimat3/ui` does no prop spreading, so there is no way to attach one through `Input` |
| No `type="number"` | the `InputType` union has no `'number'` member — a numeric field is `inputmode` plus a text type, so a locale decimal separator survives |
| `type`, `inputmode` and `autocomplete` on every input that has a right answer | **judgement** — the props exist, nothing requires them |
| One field per row. Two side by side only when they are one value (expiry month + year) | **judgement** |
| An error is an instruction: what to type, not what is wrong | **judgement** |
| The error text is announced with the control it belongs to | `Field` wires `error` into `aria-describedby` |

**16px is the floor for a touch-reachable text input.** iOS Safari zooms the viewport on focus
below it, and the zoom does not undo itself. The default control is safe — the `control` mixin sets
`font-size: var(--text-md)`, whose `clamp()` floor is `1rem` — but **`size="sm"` is not**:
`--text-sm` floors at `0.875rem` = **14px**, and `.input` is `font: inherit`. Nothing checks this.
Treat `<Input size="sm">` as desktop-only.

## Motion

| Rule | Refused by |
|---|---|
| Animate `transform` and `opacity`. Nothing else | `guards/animated-layout-property.ts` |
| Never `transition: all` | same guard |
| A `transition` naming no property **is** `all` — name the properties | same guard, which reports the omission as the implicit `all` it is |
| No layout property inside `@keyframes` | same guard |
| Reach for `t.duration()` / `t.easing()`, or `@include t.transition(<props>)`, never a literal `220ms` or a raw `cubic-bezier` | **judgement** — the scales are in `packages/ui/src/tokens/_motion.scss` and nothing refuses a literal |
| Reduced motion is honoured globally, not per component | `tokens/reset.scss` |

**Reduce means reduce — but the shipped global rule deletes.** `reset.scss`'s
`@media (prefers-reduced-motion: reduce)` sets `animation-duration` and `transition-duration` to
`0.01ms !important` on `*`, so a component that wants a cross-fade in place of movement has to win
that cascade itself: its own `prefers-reduced-motion` block, with `!important`, on a selector more
specific than `*`. Replacing movement with a cross-fade is the rule; getting it past the global
guard is work, and if you skip it the feedback is gone rather than calmed.

Never remove the feedback. A state change with no motion still needs a state change the reader
can see.

## Accessibility

| Rule | Refused by |
|---|---|
| A click is answered by a control, never by a `div` with a handler | `guards/semantic-interactive.ts` — `onClick`/`onMouseDown`/`onKeyDown` on an inert tag |
| Never `role="button"`, `role="link"` or `role="checkbox"` where the native element exists | same guard, which names the element to write instead |
| A role plus `tabindex` plus a key handler is the complete set the ARIA practices guide asks for, and is the one shape the guard passes over | same guard |
| The focus ring is replaced, never only removed | `guards/focus-visible.ts` — `outline: none\|0` with no indicator in the rule or within 600 characters of it |
| `@include t.focus-ring` is the one form | the mixin emits `:focus-visible` and the mouse-only `:focus:not(:focus-visible) { outline: none }` together; the guard recognises the include and never reads inside it |
| `:focus:not(:focus-visible) { outline: none }` is the correct idiom, not the defect | the guard never reports it |
| An icon-only control has a name | `IconButtonProps.label` is required — there is no unlabelled icon button |
| An icon with no `label` is decorative and hidden | `Icon` emits `aria-hidden="true"` unless given one |
| A live region exists before the message does | `AppShell` renders both `liveRegionAttrs` regions into the server response |
| One announcement path per message: `announce()` for a state change with no surface, a toast for a notification | **judgement** — two paths make a screen reader read it twice |
| Text meets 4.5:1 and the focus ring 3:1, in **both** themes | `packages/ui/src/tokens/contrast.test.ts`, `x verify`'s `unit` step. Shipped pairings only |

**No ARIA is better than bad ARIA** — the WAI-ARIA Authoring Practices Guide's own line, and the
measurement behind it: WebAIM's annual survey of a million home pages finds pages using ARIA
average **~41% more** detected errors than pages using none. `role="button"` is a promise the
element then owes — Space, Enter, focus order, a disabled state — and only the native element keeps
it for free.

**`announce()`'s first message can be silent.** A live region created and filled in the same frame
is not announced by most screen readers. `AppShell` renders the regions server-side so the first
message is safe; the create-if-absent fallback in a tree with no shell is right from its second
call onwards. Render `AppShell`.

**A brand override is not contrast-checked.** `defineTheme()` validates channel *syntax* — three
0–255 integers — and measures nothing. Write the test yourself; `contrastRatio`, `AA_TEXT` and
`AA_LARGE` are exported from `@ultimat3/ui` for exactly this.

## Toasts

| Rule | Refused by |
|---|---|
| Confirmations only. Never the only copy of information | **judgement** |
| Never the only affordance for an action | **judgement**, plus the shape below |
| At most one control, and it is undo-shaped | `ToastAction` is a single optional object, not a list — not taking the offer is the status quo |
| Dwell is a token, never a number at the call site | the `ToastDwell` union — `'short' \| 'long' \| 'sticky'`; a call site cannot pass `6500` |
| A `sticky` toast still carries a dismiss control | **judgement** |
| Never take focus | `ToastRegion` sets no `tabindex` and moves focus nowhere; it pauses the dwell on `focusin` instead |
| The dwell pauses on pointer, on focus, and on a hidden tab — three independent reasons, never one boolean | `ToastHold` |
| At most three on screen; the rest queue and start their dwell when they surface | `TOAST_MAX_VISIBLE` |
| The list announces the arrival, not the whole list | `ToastRegion` is `aria-atomic="false"` on the `<ol>`, and the `<ol>` — not each toast — owns `aria-live` |

A toast disappears on a timer. A keyboard user who was typing when it arrived never reached it.

## Images

| Rule | Refused by |
|---|---|
| Every image declares its box: `width` **and** `height`, or an `aspect-ratio` | `guards/image-dimensions.ts` |
| One dimension alone is a refusal, not a half-measure | `boxFor` throws `X_UI_INVALID_VALUE` — one alone reserves no aspect ratio |
| The LCP image is never lazy | `guards/image-dimensions.ts` reports `loading="lazy"` on a `priority` / `fetchpriority="high"` image; `<Image>` derives `loading` from `priority` and does not take it as a prop |
| `alt` is required. `alt=""` is a decision, made deliberately | `ImageProps.alt` has no default |
| At most one `priority` image per route | **judgement** — nothing counts them |
| `<Image>` fabricates nothing: no rendition it was not given, no dimension it did not measure | the component emits exactly what it is handed |

An unsized `<img>` is the largest single contributor to Cumulative Layout Shift: the page reflows
under the reader's finger the moment the bytes land.

## Islands

| Rule | Refused by |
|---|---|
| Every `*.island.tsx` has a sibling `*.island.states.ts` | `guards/island-without-states.ts` |
| A states file is pure data — no sibling import, no framework import | `assertIslandStatesPure`, at `x shot` load time |
| Every state carries a `note` saying why it cannot be reached by clicking | **judgement** — `note` is optional, and it is the line that tells a reviewer what they are looking at |

An island with no states file has never been seen with a refused save, an empty read, or a label
three times as long in the next locale — not by a reviewer and not by a model. How to photograph
them: [Testing](Testing#seeing-what-you-built).

## Anti-patterns to flag

Read as a review checklist. Each one is a defect on sight.

| Flag | Why |
|---|---|
| `<div onClick={…}>` | a keyboard, a screen reader and a switch reach it in exactly one way, which is not at all |
| `role="button"` on anything but `<button>` | a role is a promise; the native element is the only thing that keeps it |
| `outline: none` with nothing painted back | deletes the only thing telling a keyboard user where they are |
| `transition: all` | animates properties nobody chose, including ones not yet written |
| `transition: 220ms ease` with no property named | an omitted property **is** `all` |
| `<img>` with no `width`/`height` and no `aspect-ratio` | every element under it jumps when the bytes land |
| `loading="lazy"` on the hero image | a deliberate delay on the one paint the metric measures |
| "No results" rendered from a pending state | the four-state bug; `empty` must be unreachable before a result arrives |
| a skeleton whose box differs from the loaded content | a layout shift with extra steps |
| a spinner on a sub-100ms action | reads as a stutter |
| a progress bar with no cancel past 10s | attention is already gone |
| an optimistic write to a balance, a stock count or a permission | the rollback is visible and it is the wrong number that is remembered |
| `onPaste` blocked on a password field | it makes password managers unusable and buys nothing |
| `type="number"` for a quantity or an amount | locale decimal separators do not survive it |
| a 14px input on a touch surface | iOS zooms the viewport on focus and does not zoom back |
| a toast holding the only "Undo" for a destructive action | it expires on a timer |
| a toast that moves focus | it interrupts typing to report something that was not asked for |
| a live region created in the same frame as its first message | it is not announced |
| an icon-only button with no `label` | silence to a screen reader |
| a `*.island.tsx` with no states file | nothing has ever seen it fail |
| a literal `cubic-bezier(…)` or `220ms` in a component stylesheet | the scale exists so the curve can be retuned in one file |
| a raw hex in a component stylesheet | it does not flip with the theme |

## Where each mechanism lives

| Mechanism | File |
|---|---|
| the four-state union | `packages/ui/src/components/async-branch.ts` |
| the motion scales | `packages/ui/src/tokens/_motion.scss` |
| the global reduced-motion guard, and the default focus ring | `packages/ui/src/tokens/reset.scss` |
| `focus-ring`, `control`, `transition`, `visually-hidden` | `packages/ui/src/tokens/_mixins.scss` |
| contrast, as a failing test | `packages/ui/src/tokens/contrast.test.ts` |
| live regions and the focus trap | `packages/ui/src/a11y.ts` |
| the toast queue's rules | `packages/ui/src/toast/toast-state.ts` |
| your app's nine guards | `guards/` in the app root — `x new` writes them, `x g guard <name>` adds one |

Components, props and token vocabulary: [UI components](UI-Components). Colour roles and the
contrast table: [Theming](Theming). Seeing a component in a state you cannot click to:
[Testing](Testing#seeing-what-you-built).
