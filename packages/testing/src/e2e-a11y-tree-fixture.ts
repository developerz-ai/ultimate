// A recorded answer, not a written one: `FULL_AX_TREE` (`cdp-e2e-page.ts`) over the page below, on
// Chromium 1248 (Playwright's), 2026-11-05 — trimmed to the four fields the reader keys on. The
// audit's rules are pinned against what a browser said, so a renamed role is a red here.

/** The page the tree was read from, served as `text/html` from loopback. */
export const RECORDED_PAGE = `<!doctype html><html><head></head><body>
<button></button><button>Save</button>
<a href="/x"></a><a href="/y">Y</a>
<input type="text"><input type="search"><select></select><textarea></textarea>
<input type="checkbox"><input type="radio"><div role="switch"></div>
<input type="range"><input type="number">
<div role="tab"></div><div role="menuitem"></div>
<img src="/a.png"><img src="/b.png" alt=""><svg role="img"></svg>
<h1></h1><h2>Named</h2>
<iframe src="about:blank"></iframe>
<details><summary></summary>x</details>
<div aria-hidden="true"><button>hidden</button></div>
<div role="Iframe"></div>
</body></html>`;

/** The full-tree call's `result`, as Chrome answered it for `RECORDED_PAGE`. */
export const RECORDED_TREE: Readonly<Record<string, unknown>> = {
  nodes: [
    {
      nodeId: '2',
      ignored: false,
      role: { type: 'internalRole', value: 'RootWebArea' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 2,
    },
    { nodeId: '11', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 11 },
    { nodeId: '9', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 9 },
    {
      nodeId: '13',
      ignored: false,
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 13,
    },
    {
      nodeId: '14',
      ignored: false,
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Save' },
      backendDOMNodeId: 14,
    },
    {
      nodeId: '15',
      ignored: false,
      role: { type: 'role', value: 'link' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 15,
    },
    {
      nodeId: '16',
      ignored: false,
      role: { type: 'role', value: 'link' },
      name: { type: 'computedString', value: 'Y' },
      backendDOMNodeId: 16,
    },
    {
      nodeId: '4',
      ignored: false,
      role: { type: 'role', value: 'textbox' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 4,
    },
    {
      nodeId: '5',
      ignored: false,
      role: { type: 'role', value: 'searchbox' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 5,
    },
    {
      nodeId: '6',
      ignored: false,
      role: { type: 'role', value: 'combobox' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 6,
    },
    {
      nodeId: '7',
      ignored: false,
      role: { type: 'role', value: 'textbox' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 7,
    },
    {
      nodeId: '30',
      ignored: false,
      role: { type: 'role', value: 'checkbox' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 30,
    },
    {
      nodeId: '31',
      ignored: false,
      role: { type: 'role', value: 'radio' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 31,
    },
    {
      nodeId: '32',
      ignored: false,
      role: { type: 'role', value: 'switch' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 32,
    },
    {
      nodeId: '33',
      ignored: false,
      role: { type: 'role', value: 'slider' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 33,
    },
    {
      nodeId: '8',
      ignored: false,
      role: { type: 'role', value: 'spinbutton' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 8,
    },
    {
      nodeId: '41',
      ignored: false,
      role: { type: 'role', value: 'tab' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 41,
    },
    {
      nodeId: '42',
      ignored: false,
      role: { type: 'role', value: 'menuitem' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 42,
    },
    {
      nodeId: '43',
      ignored: false,
      role: { type: 'role', value: 'image' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 43,
    },
    {
      nodeId: '51',
      ignored: false,
      role: { type: 'role', value: 'image' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 51,
    },
    {
      nodeId: '52',
      ignored: false,
      role: { type: 'role', value: 'heading' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 52,
    },
    {
      nodeId: '53',
      ignored: false,
      role: { type: 'role', value: 'heading' },
      name: { type: 'computedString', value: 'Named' },
      backendDOMNodeId: 53,
    },
    {
      nodeId: '54',
      ignored: false,
      role: { type: 'internalRole', value: 'Iframe' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 54,
    },
    {
      nodeId: '55',
      ignored: false,
      role: { type: 'role', value: 'group' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 55,
    },
    { nodeId: '62', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 62 },
    { nodeId: '68', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 68 },
    { nodeId: '63', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 63 },
    {
      nodeId: '64',
      ignored: false,
      role: { type: 'internalRole', value: 'StaticText' },
      name: { type: 'computedString', value: 'Save' },
      backendDOMNodeId: 64,
    },
    {
      nodeId: '65',
      ignored: false,
      role: { type: 'internalRole', value: 'StaticText' },
      name: { type: 'computedString', value: 'Y' },
      backendDOMNodeId: 65,
    },
    {
      nodeId: '17',
      ignored: false,
      role: { type: 'role', value: 'generic' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 17,
    },
    { nodeId: '18', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 18 },
    {
      nodeId: '20',
      ignored: false,
      role: { type: 'role', value: 'generic' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 20,
    },
    {
      nodeId: '24',
      ignored: false,
      role: { type: 'internalRole', value: 'MenuListPopup' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 24,
    },
    {
      nodeId: '28',
      ignored: false,
      role: { type: 'role', value: 'generic' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 28,
    },
    { nodeId: '37', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 37 },
    {
      nodeId: '39',
      ignored: false,
      role: { type: 'role', value: 'generic' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 39,
    },
    {
      nodeId: '66',
      ignored: false,
      role: { type: 'internalRole', value: 'StaticText' },
      name: { type: 'computedString', value: 'Named' },
      backendDOMNodeId: 66,
    },
    { nodeId: '56', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 56 },
    {
      nodeId: '60',
      ignored: false,
      role: { type: 'internalRole', value: 'DisclosureTriangle' },
      name: { type: 'computedString', value: '' },
      backendDOMNodeId: 60,
    },
    { nodeId: '58', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 58 },
    {
      nodeId: '-1000000002',
      ignored: false,
      role: { type: 'internalRole', value: 'InlineTextBox' },
      name: { type: 'computedString', value: 'Save' },
    },
    {
      nodeId: '-1000000003',
      ignored: false,
      role: { type: 'internalRole', value: 'InlineTextBox' },
      name: { type: 'computedString', value: 'Y' },
    },
    {
      nodeId: '-1000000004',
      ignored: false,
      role: { type: 'internalRole', value: 'InlineTextBox' },
      name: { type: 'computedString', value: 'Named' },
    },
    { nodeId: '67', ignored: true, role: { type: 'role', value: 'none' }, backendDOMNodeId: 67 },
    { nodeId: '-1000000005', ignored: true, role: { type: 'role', value: 'none' } },
  ],
};
