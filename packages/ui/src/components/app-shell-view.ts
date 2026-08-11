// AppShell's two rules, kept away from the markup: the id the skip link points at is derived
// from the same place the <main> gets it, and which landmarks the frame emits in which order.
// Both are silent failures when wrong — a skip link to nowhere, or two <main> elements.

export type ShellLandmark = 'banner' | 'navigation' | 'main' | 'contentinfo';

export interface ShellIds {
  readonly mainId: string;
  /** Always `#` + `mainId`. One derivation, so the link and the target cannot drift. */
  readonly skipHref: string;
}

export interface ShellSlots {
  readonly header: boolean;
  readonly sidebar: boolean;
  readonly footer: boolean;
}

export function shellIds(base: string): ShellIds {
  const mainId = `${base}-main`;
  return { mainId, skipHref: `#${mainId}` };
}

/**
 * DOM order, which is also screen-reader order: banner, then navigation, then main, then
 * contentinfo. `main` is unconditional — a shell with no main region is not a page.
 */
export function shellLandmarks(slots: ShellSlots): readonly ShellLandmark[] {
  const out: ShellLandmark[] = [];
  if (slots.header) out.push('banner');
  if (slots.sidebar) out.push('navigation');
  out.push('main');
  if (slots.footer) out.push('contentinfo');
  return out;
}
