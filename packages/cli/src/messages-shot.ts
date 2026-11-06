// The `x shot` rows of the CLI catalog (`messages.ts` composes them): capture, compare and the
// verdict lines. Data only — `msg()` is the one lookup.

export const SHOT_MESSAGES = {
  // `x shot` — the picture is the `lines`, the verdict is the artifact. The summary names the
  // GATING fact, and a redirect comes first: a photograph of the sign-in page with every island
  // missing reads as a bug in the app, and it is a bug in the capture.
  'cli.shot.ok': '{route} clean — {islands} island(s) mounted, nothing logged and nothing threw',
  'cli.shot.errors': '{route}: {errors} console error(s) — verdict.json names each one',
  'cli.shot.redirected': '{route} redirected to {url} — the picture is not the route asked for',
  // After the redirect and before everything else: a 404 page can be spotless, and a picture of
  // "Not found" read as the route is the capture lying about its subject.
  'cli.shot.status':
    '{route} answered HTTP {status}, expected {expected} — the picture is that response, not the page',
  'cli.shot.document': '  document HTTP {status}',
  'cli.shot.documentUnknown': '  document status not seen — the driver recorded no response for it',
  'cli.shot.server.booted': '  server   booted for this shot on {url}',
  'cli.shot.server.reused': '  server   the x dev already running on {url}',
  'cli.shot.canvas': '  canvas   {width}x{height}',
  'cli.shot.canvasUnreadable': '  canvas   unreadable — {bytes} byte(s), not a decodable image',
  'cli.shot.islands': '  islands  {booted} of {declared} mounted ({strategies})',
  'cli.shot.islandsUnknown': '  islands  not counted — the page answered no probe',
  // The failure a picture cannot show and a console count cannot see: a rejected mount promise
  // calls no console method, so the FIRST one is named here rather than left to verdict.json.
  'cli.shot.islandFailed': '{route}: {failed} island(s) failed to mount — {island}: {message}',
  'cli.shot.network': '  network  {requests} request(s), {refused} refused, {dropped} dropped',
  'cli.shot.console': '  console  {level}: {text}',
  'cli.shot.threw': '{route}: {thrown} uncaught exception(s) — {first}',
  'cli.shot.pageError': '  threw    {message}  {at}',
  'cli.shot.picture': '  picture  {path}',
  'cli.shot.verdict': '  verdict  {path}',
  // `--viewport`: one route at several sizes. The summary is ONE size's verdict, so it says which
  // size; each size line leads with its size and the per-size detail lines sit indented beneath.
  'cli.shot.viewport.summary': '{size}: {summary}',
  'cli.shot.viewport.line': '{size}  {summary}',
  // `--island`. A component capture reports per STATE, so the summary counts pictures and the
  // lines name one state each; nothing here restates a fact `--json` does not carry.
  'cli.shot.island.ok':
    '{island} clean — {pictures} picture(s), every one mounted, nothing logged and nothing threw',
  'cli.shot.island.failed':
    '{island}: {taken} of {expected} declared picture(s) taken — verdict.json names each refusal',
  'cli.shot.island.state': '  {state}  {theme}  {width}x{height}  {file}',
  'cli.shot.island.missing': '  missing  {file} — no picture was taken for this declared state',
  'cli.shot.island.picture': '  pictures {path}',
  'cli.shot.island.verdict': '  verdict  {path}',
  'cli.shot.island.index': '  index    {path}',
  'cli.shot.island.blind.crop':
    "the picture is the crop target and a thin margin around it — anything further out, including the space a component's own fault sits in, is outside the frame; content that overflows the box is recorded per state as overflow, never shown",
  'cli.shot.island.blind.locale':
    'toLocaleString() on a Date resolves its zone inside the engine — only an explicit timeZone is pinned by this harness',
} as const;
