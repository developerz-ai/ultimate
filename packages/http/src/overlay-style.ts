// The dev overlay's stylesheet, split from the document that carries it so `security-headers.ts`
// can hash it into the CSP without importing the renderer — and so the hash is computed from the
// one copy of the text, never from a constant that drifted away from what the `<style>` holds.

// Token definitions live here and nowhere else; every rule below uses var().
export const OVERLAY_STYLE = `
:root {
  --x-bg: #fbfbfd; --x-surface: #ffffff; --x-border: #e3e3ea;
  --x-text: #1b1b1f; --x-muted: #6b6b76; --x-danger: #b3261e; --x-accent: #2f4fd8;
  --x-code-bg: #f3f3f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --x-bg: #111115; --x-surface: #1a1a20; --x-border: #2e2e38;
    --x-text: #ececf1; --x-muted: #9b9baa; --x-danger: #ff8a80; --x-accent: #9db2ff;
    --x-code-bg: #22222b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem; background: var(--x-bg); color: var(--x-text);
  font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
main { max-width: 60rem; margin: 0 auto; }
.card {
  background: var(--x-surface); border: 1px solid var(--x-border);
  border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1rem;
}
h1 { font-size: 1.1rem; margin: 0 0 .25rem; color: var(--x-danger); }
h2 { font-size: .8rem; margin: 0 0 .5rem; color: var(--x-muted);
     text-transform: uppercase; letter-spacing: .08em; }
dl { display: grid; grid-template-columns: 5rem 1fr; gap: .35rem 1rem; margin: 0; }
dt { color: var(--x-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre { background: var(--x-code-bg); border-radius: 6px; padding: .75rem;
      margin: 0; overflow-x: auto; }
a { color: var(--x-accent); }
.title { color: var(--x-muted); font-weight: normal; }
/* A notice's term is an X_ code, not a five-character label: at the shared 5rem the codes this
   card exists to show would sit on top of their own causes. */
.notices dl { grid-template-columns: 14rem 1fr; }
.notices dt { overflow-wrap: anywhere; }
`;
