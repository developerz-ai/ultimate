// A HELD island (#506): server markup that must not paint before the island mounts, because what
// it shows can be older than what the page will show — an offline reload's cached count, under a
// queued write the mount rebuilds. Hidden from its first byte, booted at once, revealed when the
// mount settles or at the cap. Who is held is the renderer's caller's call (`hold` on the collector):
// only an island with page state to restore — server markup nothing will contradict is never hidden.

/** On a held island's wrapper until the runtime reveals it; what the runtime finds it by. */
export const ISLAND_HOLD_ATTRIBUTE = 'data-x-hold';

/**
 * The longest a held island stays hidden, whatever its chunk does — a download on a slow network,
 * a mount that never settles. Above `@ultimat3/realtime`'s `FIRST_PAINT_HOLD_MS` (1 s), the cap on
 * the disk restore a realtime island waits for, so a slow disk meets that cap and still mounts
 * before this one shows the server's markup. Interpolated into the runtime: one number, one copy.
 */
export const ISLAND_HOLD_MS = 3_000;

/**
 * The keyframes that reveal a held island with no script at all — JS off, the runtime blocked, a
 * strategy part that threw before the hold could run. Defined in `@ultimat3/ui`'s `global.scss`
 * (this package may not import `ui`; `island-hold-replay.test.ts` holds the two spellings equal),
 * beside the `@media (scripting: none)` rule that cancels the hold at once where the browser says
 * scripting is off: the keyframes are the cap for everything that rule cannot see.
 */
export const ISLAND_HOLD_REVEAL = 'ultimate-hold-reveal';

/**
 * The wrapper's attributes. An inline `style` and not a stylesheet rule: it applies from the byte
 * the parser reads (no sheet can have loaded yet), and `@ultimat3/http`'s policy admits a style
 * ATTRIBUTE (`style-src-attr`) where an inline `<style>` would need a hash. `visibility`, never
 * `display`: the island keeps its box, so the reveal shifts no layout. The animation is the reveal
 * that needs no script: a zero-length step to `visible` after the cap, held by `forwards` (reduced
 * motion shortens durations, never delays). The runtime takes both properties off when it reveals.
 */
export const ISLAND_HOLD_ATTRIBUTES =
  `${ISLAND_HOLD_ATTRIBUTE} ` +
  `style="visibility:hidden;animation:${ISLAND_HOLD_REVEAL} 0s ${ISLAND_HOLD_MS}ms forwards"`;

// Booted at once, whatever the route's strategy: a hidden island receives no press and sits in no
// idle slot worth waiting for, so `interaction` would hold it until the cap and show the stale
// markup anyway. `boot` is the prelude's, so the strategy below chains on the SAME `el.__x` and
// mounts nothing twice. `el.__h`, not `each`'s `el.__v`: `each` would mark the root visited and
// the strategy's own pass would then skip it. Emitted FIRST after the prelude (`hydrate.ts`), so
// a strategy part that throws — an old WebView with no IntersectionObserver — cannot strand it.
// The strategy's capture listeners let go on the first event after the mount (`catchUp`'s `on`),
// since the hold, not a caught event, is what booted the island.
//
// Revealed TOGETHER, once every held island of this pass has settled (or at the cap): one record
// shown in two islands is rebuilt by whichever island holds its writer — a queued write's overlay
// is restored inside THAT island's mount — so a reader revealed at its own mount painted the
// record without it (#506, measured in `offline-like.e2e.test.ts`). A failed mount counts as
// settled (`hush`): its server markup is shown rather than hidden forever.
export const RUNTIME_HOLD = `
var hs=[];Array.prototype.forEach.call(document.querySelectorAll('[${ISLAND_HOLD_ATTRIBUTE}]'),function(el){
if(!el.__h){el.__h=1;hs.push(el)}});
if(hs.length){var t,r=function(){clearTimeout(t);hs.forEach(function(el){el.removeAttribute('${ISLAND_HOLD_ATTRIBUTE}');
el.style.removeProperty('visibility');el.style.removeProperty('animation')})};
t=setTimeout(r,${ISLAND_HOLD_MS});Promise.all(hs.map(function(el){return boot(el).then(null,hush)})).then(r)}
`.trim();
