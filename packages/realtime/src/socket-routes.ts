// The engine's multiplexing: which port wants which channel topic and which live query, so the
// one socket carries ONE membership per topic and every server frame is ROUTED only to the ports
// that want it — never broadcast. It holds no socket; the engine hands it `send` and `post`.

import { CHANNEL_SID_PREFIX } from './client-channels';
import type { AttachedPort, PortMessage } from './socket-port';
import { encode, type Frame, PROTOCOL_VERSION, type SubscribeFrame } from './sync-protocol';

export interface RouterDeps {
  /** To the node, when the socket is up. */
  send(frame: Frame): void;
  post(attached: AttachedPort, message: PortMessage): void;
  port(id: number): AttachedPort | undefined;
  ports(): Iterable<AttachedPort>;
}

/** The frames the router routes; the engine keeps `hello`, `update-available` and `reconnect`. */
type RoutedFrame = Extract<
  Frame,
  { readonly type: 'snapshot' | 'patch' | 'ack' | 'records' | 'replay-gap' | 'events' }
>;

export class PortRouter {
  readonly #deps: RouterDeps;
  /**
   * Topic → the ports that want it, the add frame that joined it, and the epoch the node last
   * named for it — what a later port is told to re-read in.
   */
  readonly #topics = new Map<
    string,
    { readonly ports: Set<number>; readonly add: SubscribeFrame; epoch: string | null }
  >();

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  /** A tab's `subscribe`: a channel membership, or a live query under a port-scoped sid. */
  subscribe(attached: AttachedPort, frame: SubscribeFrame): void {
    if (frame.target.kind === 'channel') {
      this.#channel(attached, frame);
      return;
    }
    if (frame.target.kind !== 'query') return;
    // Every tab mints its own sids; the engine's sid carries the port so two tabs never collide.
    const sid = `${attached.id}|${frame.sid}`;
    const rewritten: SubscribeFrame = { ...frame, sid };
    if (frame.op === 'add') attached.lives.set(sid, rewritten);
    else attached.lives.delete(sid);
    this.#deps.send(rewritten);
  }

  /** Release what a port held: its channel wants and its live registrations. */
  release(attached: AttachedPort): void {
    for (const topic of attached.topics) {
      const add = this.#topics.get(topic)?.add;
      if (add !== undefined) this.#leave(attached.id, topic, { ...add, op: 'drop' });
    }
    attached.topics.clear();
    for (const add of attached.lives.values()) this.#deps.send({ ...add, op: 'drop' });
    attached.lives.clear();
  }

  /** One server frame to the ports it belongs to. `data` is the frame as the socket carried it. */
  route(frame: RoutedFrame, data: string): void {
    switch (frame.type) {
      case 'snapshot':
      case 'patch':
        this.#toLive(frame.sid, (sid) => ({ ...frame, sid }));
        return;
      case 'ack': {
        const ref = frame.ref;
        if (ref.includes('|')) this.#toLive(ref, (local) => ({ ...frame, ref: local }));
        else if (this.#topics.has(ref)) this.#toTopic(ref, data);
        else for (const attached of this.#deps.ports()) this.#frame(attached, data);
        return;
      }
      case 'records':
      case 'replay-gap': {
        const held = this.#topics.get(`${CHANNEL_SID_PREFIX}${frame.channel}`);
        if (held !== undefined) held.epoch = frame.epoch;
        this.#toTopic(`${CHANNEL_SID_PREFIX}${frame.channel}`, data);
        return;
      }
      case 'events':
        this.#toTopic(`${CHANNEL_SID_PREFIX}${frame.channel}`, data);
        return;
    }
  }

  /**
   * Re-announcing each channel IS the node's presence heartbeat — with no `since`, so it replays
   * nothing.
   */
  announce(): void {
    for (const { add } of this.#topics.values()) this.#deps.send(withoutSince(add));
  }

  /** The socket is gone: every membership goes with it; each tab resubscribes from its cursors. */
  clear(): void {
    this.#topics.clear();
    for (const attached of this.#deps.ports()) {
      attached.topics.clear();
      attached.lives.clear();
    }
  }

  /** One membership per topic across every port; the first `add` joins, the last leave drops. */
  #channel(attached: AttachedPort, frame: SubscribeFrame): void {
    const topic = frame.sid;
    const held = this.#topics.get(topic);
    if (frame.op !== 'add') {
      attached.topics.delete(topic);
      this.#leave(attached.id, topic, frame);
      return;
    }
    attached.topics.add(topic);
    if (held === undefined) {
      this.#topics.set(topic, { ports: new Set([attached.id]), add: frame, epoch: null });
      this.#deps.send(frame);
      return;
    }
    if (held.ports.has(attached.id)) return;
    held.ports.add(attached.id);
    // The node never hears this add, so it cannot answer it with the `replay-gap` a fresh seat
    // gets; the engine does. With no epoch yet, the node's own answer is still on its way and now
    // reaches this port too.
    if (held.epoch === null) return;
    const gap: Frame = {
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: topic.slice(CHANNEL_SID_PREFIX.length),
      epoch: held.epoch,
    };
    this.#frame(attached, encode(gap));
  }

  #leave(id: number, topic: string, drop: SubscribeFrame): void {
    const held = this.#topics.get(topic);
    if (held === undefined) return;
    held.ports.delete(id);
    if (held.ports.size > 0) return;
    this.#topics.delete(topic);
    this.#deps.send(drop);
  }

  #toLive(engineSid: string, rewrite: (localSid: string) => Frame): void {
    const bar = engineSid.indexOf('|');
    const attached = this.#deps.port(Number(engineSid.slice(0, bar)));
    if (attached !== undefined) this.#frame(attached, encode(rewrite(engineSid.slice(bar + 1))));
  }

  #toTopic(topic: string, data: string): void {
    for (const id of this.#topics.get(topic)?.ports ?? []) {
      const attached = this.#deps.port(id);
      if (attached !== undefined) this.#frame(attached, data);
    }
  }

  #frame(attached: AttachedPort, data: string): void {
    this.#deps.post(attached, { t: 'frame', data });
  }
}

/** A channel's `add` without its resume point — the beat repeats a membership, it resumes nothing. */
function withoutSince(add: SubscribeFrame): SubscribeFrame {
  if (add.target.kind !== 'channel') return add;
  const { since: _since, ...target } = add.target;
  return { ...add, target };
}
