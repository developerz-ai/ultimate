// The one expression `ui.inspect` runs in the page, and the parser that refuses to trust what
// came back. Built from plain values and DETERMINISTIC for one spec: the offline drivers answer
// `evaluate` from a recording keyed by the exact expression string, so `mcp-ui-inspect.test.ts`
// records against `inspectExpression(spec)` and proves the whole tool on a box with no Chrome.
//
// Every cap is applied IN the page — matches, text length, attribute count — so the wire payload
// is bounded before the browser serialises it. A `*` selector on a long page is thousands of
// nodes, and `textContent` of `<body>` is the whole document; a probe that fetched all of it and
// trimmed afterwards would still have paid for all of it.

import { UI_INSPECT_LIMITS } from '@ultimat3/mcp';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t, validate } from '@ultimat3/schema';

export interface InspectSpec {
  readonly selectors: readonly string[];
  /** Computed property names, kebab-case, already filtered by the tool handler. */
  readonly styles: readonly string[];
  readonly activeElement: boolean;
}

export interface InspectProbeMatch {
  readonly tag: string;
  readonly text: string;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly visible: boolean;
  readonly attrs: Readonly<Record<string, string>>;
  readonly styles: Readonly<Record<string, string>>;
}

export interface InspectProbeSelector {
  readonly selector: string;
  readonly valid: boolean;
  readonly count: number;
  readonly truncated: boolean;
  readonly matches: readonly InspectProbeMatch[];
}

export interface InspectProbe {
  readonly title: string;
  readonly theme: string | null;
  readonly activeElement: {
    readonly tag: string;
    readonly id: string;
    readonly role: string;
    readonly name: string;
  } | null;
  readonly selectors: readonly InspectProbeSelector[];
}

/**
 * ES5 and an expression, never a closure: `CdpPageLike.evaluate` takes the string form only, and
 * the page may be older than the CLI. `querySelectorAll` runs inside a `try` so a selector the
 * engine cannot parse is reported as `valid: false` beside the ones it could — one bad selector
 * must not cost the whole navigation. Rounded boxes: a sub-pixel `x` is noise an agent diffs on.
 */
export function inspectExpression(spec: InspectSpec): string {
  const selectors = JSON.stringify([...spec.selectors]);
  const styles = JSON.stringify([...spec.styles]);
  const active = spec.activeElement ? 'true' : 'false';
  const { matches, textChars, attrs } = UI_INSPECT_LIMITS;
  return (
    `(function(){var S=${selectors};var P=${styles};var A=${active};` +
    'function nm(el){return el.getAttribute("aria-label")||el.getAttribute("name")||"";}' +
    `function at(el){var o={};var a=el.attributes;for(var i=0;i<a.length&&i<${attrs};i+=1){` +
    `o[a[i].name]=String(a[i].value).slice(0,${textChars});}return o;}` +
    'function st(el){var o={};if(P.length===0)return o;var cs=getComputedStyle(el);' +
    'for(var i=0;i<P.length;i+=1){o[P[i]]=cs.getPropertyValue(P[i]);}return o;}' +
    'function m(el){var r=el.getBoundingClientRect();var cs=getComputedStyle(el);' +
    'return{tag:el.tagName.toLowerCase(),' +
    `text:(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,${textChars}),` +
    'box:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},' +
    'visible:r.width>0&&r.height>0&&cs.visibility!=="hidden"&&cs.display!=="none",' +
    'attrs:at(el),styles:st(el)};}' +
    'var out=[];for(var i=0;i<S.length;i+=1){var sel=S[i];var els;' +
    'try{els=document.querySelectorAll(sel);}catch(e){' +
    'out.push({selector:sel,valid:false,count:0,truncated:false,matches:[]});continue;}' +
    `var ms=[];for(var j=0;j<els.length&&j<${matches};j+=1)ms.push(m(els[j]));` +
    `out.push({selector:sel,valid:true,count:els.length,truncated:els.length>${matches},matches:ms});}` +
    'var ae=document.activeElement;var active=A&&ae?{tag:ae.tagName.toLowerCase(),id:ae.id||"",' +
    'role:ae.getAttribute("role")||"",name:nm(ae)}:null;' +
    'return{title:document.title||"",theme:document.documentElement.getAttribute("data-theme"),' +
    'activeElement:active,selectors:out};})()'
  );
}

const matchSchema = t.object({
  tag: t.string,
  text: t.string.min(0),
  box: t.object({ x: t.number, y: t.number, width: t.number, height: t.number }),
  visible: t.boolean,
  attrs: t.record(t.string.min(0)),
  styles: t.record(t.string.min(0)),
});

const inspectProbeSchema: StandardSchemaV1<unknown, InspectProbe> = t.object({
  title: t.string.min(0),
  theme: t.nullable(t.string.min(0)),
  activeElement: t.nullable(
    t.object({
      tag: t.string,
      id: t.string.min(0),
      role: t.string.min(0),
      name: t.string.min(0),
    }),
  ),
  selectors: t.array(
    t.object({
      selector: t.string.min(0),
      valid: t.boolean,
      count: t.number,
      truncated: t.boolean,
      matches: t.array(matchSchema),
    }),
  ),
}) as unknown as StandardSchemaV1<unknown, InspectProbe>;

/**
 * `evaluate()` answers `unknown` on every driver, so the probe's result is PARSED and never cast —
 * the rule `parseIslandProbe` follows. `null` for anything that does not fit: the picture and the
 * verdict were already taken, and a malformed probe must not take them down with it.
 */
export function parseInspectProbe(value: unknown): InspectProbe | null {
  const result = validate(inspectProbeSchema, value);
  return result.issues === undefined ? result.value : null;
}
