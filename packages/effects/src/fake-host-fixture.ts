// TEST-ONLY. A host, a canvas, a WebGL2 context and a 2D context small enough to read: every call
// a mount makes is recorded, frames are driven by hand, and context loss is one method call. Never
// exported from `index.ts`.

import type { EffectHost } from './effect-host';

export type Call = readonly [string, ...unknown[]];

export class FakeGl {
  readonly calls: Call[] = [];
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly TRIANGLES = 0x0004;
  compiles = true;
  links = true;
  lost = false;
  sources: string[] = [];

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }
  count(name: string): number {
    return this.calls.filter((call) => call[0] === name).length;
  }
  createShader(type: number): object {
    this.record('createShader', type);
    return { type };
  }
  shaderSource(_shader: object, source: string): void {
    this.sources.push(source);
  }
  compileShader(): void {}
  getShaderParameter(): boolean {
    return this.compiles;
  }
  createProgram(): object {
    this.record('createProgram');
    return {};
  }
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return this.links;
  }
  getUniformLocation(_program: object, name: string): object {
    return { name };
  }
  useProgram(): void {}
  viewport(...args: number[]): void {
    this.record('viewport', ...args);
  }
  uniform1f(location: { name: string }, value: number): void {
    this.record('uniform', location.name, value);
  }
  uniform2fv(location: { name: string }, value: Float32Array): void {
    this.record('uniform', location.name, [...value]);
  }
  uniform3fv(location: { name: string }, value: Float32Array): void {
    this.record('uniform', location.name, [...value]);
  }
  uniform4fv(location: { name: string }, value: Float32Array): void {
    this.record('uniform', location.name, [...value]);
  }
  drawArrays(...args: number[]): void {
    this.record('drawArrays', ...args);
  }
  deleteProgram(): void {
    this.record('deleteProgram');
  }
  deleteShader(): void {
    this.record('deleteShader');
  }
  isContextLost(): boolean {
    return this.lost;
  }
  getExtension(name: string): object | null {
    if (name !== 'WEBGL_lose_context') return null;
    return { loseContext: () => this.record('loseContext') };
  }
}

export class FakeContext2d {
  readonly calls: Call[] = [];
  fillStyle: unknown = '';
  globalAlpha = 1;
  setTransform(...args: number[]): void {
    this.calls.push(['setTransform', ...args]);
  }
  clearRect(...args: number[]): void {
    this.calls.push(['clearRect', ...args]);
  }
  fillRect(...args: number[]): void {
    this.calls.push(['fillRect', ...args]);
  }
  beginPath(): void {}
  arc(...args: number[]): void {
    this.calls.push(['arc', ...args]);
  }
  fill(): void {
    this.calls.push(['fill']);
  }
  createRadialGradient(...args: number[]): {
    addColorStop: (offset: number, colour: string) => void;
  } {
    this.calls.push(['createRadialGradient', ...args]);
    return { addColorStop: (offset, colour) => this.calls.push(['stop', offset, colour]) };
  }
  createLinearGradient(...args: number[]): {
    addColorStop: (offset: number, colour: string) => void;
  } {
    this.calls.push(['createLinearGradient', ...args]);
    return { addColorStop: (offset, colour) => this.calls.push(['stop', offset, colour]) };
  }
}

type Listener = (event: { preventDefault: () => void }) => void;

export class FakeCanvas {
  width = 300;
  height = 150;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly attributes = new Map<string, string>();
  gl: FakeGl | null = new FakeGl();
  ctx: FakeContext2d | null = new FakeContext2d();
  prevented = 0;

  getContext(kind: string): unknown {
    if (kind === 'webgl2') return this.gl;
    if (kind === '2d') return this.ctx;
    return null;
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault: () => this.prevented++ });
    }
  }
  listening(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

/** An element whose attributes a test can read: the root a mount labels. */
export class FakeRoot extends FakeCanvas {}

/** Channel values for every role a default palette names. */
export const FAKE_CHANNELS = '120 80 200';

export class FakeHost implements EffectHost {
  time = 0;
  allowedNow = true;
  ratio = 2;
  size: readonly [number, number] = [400, 300];
  visible = true;
  vars: (name: string) => string = () => FAKE_CHANNELS;
  readonly ticks = new Set<() => void>();
  readonly motionListeners = new Set<() => void>();
  readonly sizeListeners = new Set<(w: number, h: number) => void>();
  readonly visibleListeners = new Set<(visible: boolean) => void>();
  readonly themeListeners = new Set<() => void>();

  readonly motion = {
    loop: (tick: () => void): (() => void) => {
      this.ticks.add(tick);
      return () => this.ticks.delete(tick);
    },
    allowed: (): boolean => this.allowedNow,
    onChange: (listener: () => void): (() => void) => {
      this.motionListeners.add(listener);
      return () => this.motionListeners.delete(listener);
    },
  };
  readonly now = (): number => this.time;
  readonly dpr = (): number => this.ratio;
  readonly observeSize = (_el: Element, onSize: (w: number, h: number) => void): (() => void) => {
    this.sizeListeners.add(onSize);
    onSize(...this.size);
    return () => this.sizeListeners.delete(onSize);
  };
  readonly observeVisible = (_el: Element, onVisible: (visible: boolean) => void): (() => void) => {
    this.visibleListeners.add(onVisible);
    onVisible(this.visible);
    return () => this.visibleListeners.delete(onVisible);
  };
  readonly observeTheme = (onChange: () => void): (() => void) => {
    this.themeListeners.add(onChange);
    return () => this.themeListeners.delete(onChange);
  };
  readonly readVar = (_el: Element, name: string): string => this.vars(name);

  /** Advances the clock by `ms` and runs every live tick once. */
  frame(ms = 16): void {
    this.time += ms;
    for (const tick of [...this.ticks]) tick();
  }
  setMotion(allowed: boolean): void {
    this.allowedNow = allowed;
    for (const listener of [...this.motionListeners]) listener();
  }
  resize(width: number, height: number): void {
    this.size = [width, height];
    for (const listener of [...this.sizeListeners]) listener(width, height);
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.visibleListeners]) listener(visible);
  }
  setTheme(vars: (name: string) => string): void {
    this.vars = vars;
    for (const listener of [...this.themeListeners]) listener();
  }
  live(): number {
    return (
      this.ticks.size +
      this.motionListeners.size +
      this.sizeListeners.size +
      this.visibleListeners.size +
      this.themeListeners.size
    );
  }
}

/** A fake as the DOM type a mount takes: the fixture implements only what a mount calls. */
export function asCanvas(canvas: FakeCanvas): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement;
}
export function asElement(root: FakeCanvas): HTMLElement {
  return root as unknown as HTMLElement;
}
