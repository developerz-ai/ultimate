// The two scripts `x design research` runs INSIDE a reference page, as text: one installed before
// the document's own scripts, one run after load that scrolls, hovers and reads computed styles.
//
// Both answer numbers and CSS keywords only — no page text leaves the page. `design-extract.ts`
// parses and re-sanitises what they answer anyway: the page can overwrite anything installed here.

/**
 * Before the document: no WebSocket (see the comment inside), then every Animation the page starts — `Element.animate`, a CSS animation, a CSS
 * transition — is recorded with the phase it started in (`enter` until the pass moves it on). The
 * recorder is reached through one non-enumerable global the pass reads back.
 */
export const DESIGN_PREPARE = `(() => {
  if (window.__xDesign) return;
  // CDP's Fetch domain never pauses a WebSocket handshake, so nothing could screen where one dials:
  // a reference gets none. Installed before the page's scripts, in every frame, and not writable.
  const refuse = function WebSocket() { throw new DOMException('x design research opens no WebSocket', 'SecurityError'); };
  for (const name of ['WebSocket', 'WebSocketStream', 'WebTransport']) {
    try { Object.defineProperty(window, name, { value: refuse, writable: false, configurable: false }); } catch {}
  }
  const records = [];
  const seen = new WeakSet();
  const state = { phase: 'enter' };
  const SKIP = new Set(['offset', 'easing', 'composite', 'computedOffset']);
  const record = (animation) => {
    if (!animation || seen.has(animation) || records.length >= 400) return;
    seen.add(animation);
    const effect = animation.effect;
    if (!effect || typeof effect.getTiming !== 'function') return;
    const timing = effect.getTiming();
    let frames = [];
    try { frames = effect.getKeyframes(); } catch {}
    const properties = new Set();
    for (const frame of frames) for (const key of Object.keys(frame)) if (!SKIP.has(key)) properties.add(key);
    const frameEasing = frames.find((frame) => frame.easing && frame.easing !== 'linear');
    const timeline = animation.timeline && animation.timeline.constructor ? animation.timeline.constructor.name : '';
    const scrollDriven = /Scroll|View/.test(timeline);
    const infinite = timing.iterations === Infinity;
    records.push({
      kind: animation.constructor && animation.constructor.name === 'CSSTransition' ? 'transition' : 'animation',
      trigger: scrollDriven ? 'scroll' : infinite ? 'loop' : state.phase,
      durationMs: typeof timing.duration === 'number' ? timing.duration : 0,
      delayMs: typeof timing.delay === 'number' ? timing.delay : 0,
      easing: String(timing.easing && timing.easing !== 'linear' ? timing.easing : frameEasing ? frameEasing.easing : 'linear'),
      iterations: infinite ? -1 : Number(timing.iterations) || 1,
      properties: [...properties].slice(0, 12),
    });
  };
  const original = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const animation = original.apply(this, args);
    record(animation);
    return animation;
  };
  const sweep = () => { try { for (const animation of document.getAnimations()) record(animation); } catch {} };
  for (const type of ['animationstart', 'transitionrun']) document.addEventListener(type, sweep, true);
  Object.defineProperty(window, '__xDesign', {
    value: { records, state, sweep },
    enumerable: false,
  });
})()`;

/** After load: the scroll and hover passes, then the computed-style census. Answers one object. */
export const DESIGN_PASS = `(async () => {
  const x = window.__xDesign;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const records = x ? x.records : [];
  const sweep = () => { if (x) x.sweep(); };
  const phase = (name) => { if (x) x.state.phase = name; };
  await wait(400);
  sweep();
  phase('scroll');
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  const bottom = Math.min(document.documentElement.scrollHeight, 40000);
  for (let y = step, steps = 0; y < bottom + step && steps < 25; y += step, steps += 1) {
    scrollTo({ top: y, behavior: 'instant' });
    await wait(60);
    sweep();
  }
  scrollTo({ top: 0, behavior: 'instant' });
  await wait(60);
  phase('hover');
  const hoverable = [...document.querySelectorAll('a, button, [role="button"], [class*="card" i]')].slice(0, 30);
  for (const el of hoverable) {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over') }));
    await wait(20);
    sweep();
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('out') }));
  }
  phase('state');

  const canvas = document.createElement('canvas').getContext('2d');
  const rgba = (value) => {
    if (!canvas || !value || value === 'transparent') return null;
    canvas.fillStyle = '#000000';
    canvas.fillStyle = value;
    const norm = String(canvas.fillStyle);
    if (norm.startsWith('#')) return [parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16), parseInt(norm.slice(5, 7), 16), 1];
    const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(norm);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
  };
  const px = (value) => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  const bump = (map, key, by, make) => { const held = map.get(key); if (held) held.n += by; else map.set(key, { ...make(), n: by }); };

  const hoverBases = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      const text = rule.selectorText;
      if (typeof text === 'string' && text.includes(':hover') && hoverBases.length < 400) {
        for (const part of text.split(',')) { const base = part.replace(/:hover/g, '').trim(); if (base) hoverBases.push(base); }
      }
    }
  }
  const hovered = (el) => hoverBases.some((base) => { try { return el.matches(base) || el.matches(base + ' *'); } catch { return false; } });

  const colors = new Map(); const fonts = new Map(); const spacing = new Map(); const radii = new Map(); const shadows = new Map();
  const backdrop = { count: 0, blurPx: [] };
  let canvases = 0;
  const cap = innerWidth * innerHeight * 4;
  const elements = [document.documentElement, document.body, ...document.querySelectorAll('body *')].filter(Boolean).slice(0, 3000);
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    const area = box.width * box.height;
    if (area <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (el.tagName === 'CANVAS') canvases += 1;
    const bg = rgba(cs.backgroundColor);
    if (bg && bg[3] > 0.05) bump(colors, 'background ' + bg.join(' '), Math.min(area, cap), () => ({ rgb: bg.slice(0, 3), alpha: bg[3], use: 'background' }));
    let textLength = 0;
    for (const node of el.childNodes) if (node.nodeType === 3) textLength += node.textContent.trim().length;
    if (textLength > 0) {
      const fg = rgba(cs.color);
      if (fg) bump(colors, 'text ' + fg.join(' '), Math.min(textLength, 500), () => ({ rgb: fg.slice(0, 3), alpha: fg[3], use: 'text' }));
      const family = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const size = Math.round(px(cs.fontSize));
      const weight = Number(cs.fontWeight) || 400;
      bump(fonts, family + '|' + size + '|' + weight, Math.min(textLength, 500), () => ({ family, sizePx: size, weight }));
    }
    if (px(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') {
      const line = rgba(cs.borderTopColor);
      if (line && line[3] > 0.05) bump(colors, 'border ' + line.join(' '), 1, () => ({ rgb: line.slice(0, 3), alpha: line[3], use: 'border' }));
    }
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const value = Math.round(px(cs[side]));
      if (value > 0 && value < 400) bump(spacing, value, 1, () => ({ px: value }));
    }
    const radius = cs.borderTopLeftRadius;
    if (!radius.includes('%')) { const value = Math.round(px(radius)); if (value > 0 && value < 1000) bump(radii, value, 1, () => ({ px: value })); }
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      const first = cs.boxShadow.split(/,(?![^(]*\\))/)[0];
      const color = rgba((/rgba?\\([^)]*\\)|#[0-9a-f]{3,8}/i.exec(first) || ['transparent'])[0]);
      const lengths = (first.replace(/rgba?\\([^)]*\\)|#[0-9a-f]{3,8}/gi, '').match(/-?[\\d.]+px/g) || []).map(px);
      const shadow = { x: lengths[0] || 0, y: lengths[1] || 0, blur: lengths[2] || 0, spread: lengths[3] || 0, inset: first.includes('inset'), rgb: color ? color.slice(0, 3) : [0, 0, 0], alpha: color ? color[3] : 0 };
      bump(shadows, JSON.stringify(shadow), 1, () => shadow);
    }
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      backdrop.count += 1;
      const blur = /blur\\(([\\d.]+)px\\)/.exec(cs.backdropFilter);
      if (blur && backdrop.blurPx.length < 20) backdrop.blurPx.push(Number(blur[1]));
    }
    const durations = cs.transitionDuration.split(',').map((d) => px(d) * (d.trim().endsWith('ms') ? 1 : 1000));
    if (durations.some((d) => d > 0) && records.length < 600) {
      const easings = cs.transitionTimingFunction.split(/,(?![^(]*\\))/);
      const delays = cs.transitionDelay.split(',').map((d) => px(d) * (d.trim().endsWith('ms') ? 1 : 1000));
      const properties = cs.transitionProperty.split(',').map((p) => p.trim());
      durations.forEach((duration, i) => {
        if (duration <= 0) return;
        records.push({ kind: 'transition', trigger: hovered(el) ? 'hover' : 'state', durationMs: duration, delayMs: delays[i % delays.length] || 0, easing: (easings[i % easings.length] || 'ease').trim(), iterations: 1, properties: [properties[i % properties.length] || 'all'] });
      });
    }
  }
  const top = (map, n) => [...map.values()].sort((a, b) => b.n - a.n).slice(0, n);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    colors: top(colors, 64).map((c) => ({ rgb: c.rgb, alpha: c.alpha, use: c.use, weight: c.n })),
    fonts: top(fonts, 24).map((f) => ({ family: f.family, sizePx: f.sizePx, weight: f.weight, uses: f.n })),
    spacing: top(spacing, 32).map((s) => ({ px: s.px, count: s.n })),
    radii: top(radii, 16).map((r) => ({ px: r.px, count: r.n })),
    shadows: top(shadows, 12).map((s) => ({ x: s.x, y: s.y, blur: s.blur, spread: s.spread, inset: s.inset, rgb: s.rgb, alpha: s.alpha, count: s.n })),
    backdrop,
    canvases,
    motion: records.slice(0, 600),
    links: [...document.querySelectorAll('a[href]')].slice(0, 300).map((a) => a.href),
  };
})()`;
