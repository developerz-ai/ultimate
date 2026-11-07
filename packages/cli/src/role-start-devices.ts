// The device sockets one process hosts: every declared `deviceSocket()` attached to its bus, and —
// on the web role — one listener mount per path that resolves the declaration PER UPGRADE. A
// container's declarations never change; `x dev`'s rescan re-declares a saved path in a new
// generation, and `refresh()` attaches that value and drains the one it replaced.

import type { Role } from '@ultimat3/core';
import type {
  DeviceAttachment,
  DeviceSocket,
  DeviceUpgradeTarget,
  DeviceWs,
  Transport,
} from '@ultimat3/realtime/server';
import { declaredDeviceSockets } from '@ultimat3/realtime/server';

/** What the listener is handed: a declaration's own mount shape, so `httpServer` takes it as one. */
export type DeviceMount = Pick<DeviceSocket, 'path' | 'fetch' | 'websocket'>;

export interface DeviceHosting {
  /** One per path declared at boot; empty without the web role, which is where devices dial. */
  readonly mounts: readonly DeviceMount[];
  /**
   * After a rescan: each re-declared path's new value attached, the old one's sockets told to
   * reconnect and closed, its attachment stopped. Answers the declared paths the listener does not
   * serve — added after it bound, which only a new process can open.
   */
  refresh(): Promise<readonly string[]>;
  /** Every attachment stopped, newest first. */
  stop(): Promise<void>;
}

interface Held {
  readonly link: DeviceSocket;
  readonly attachment: DeviceAttachment;
}

/**
 * The listener's door for one path. The upgrade is answered by the path's CURRENT declaration, and
 * each socket's events go back to the declaration that upgraded it — keyed by the `data` it handed
 * `server.upgrade`, `joinWebSocketMounts`'s rule — so a socket opened before a reload is closed by
 * the host that holds it, never handed to one that does not.
 */
function pathMount(path: string, current: () => DeviceSocket): DeviceMount {
  const owners = new WeakMap<object, DeviceSocket>();
  const ownerOf = (ws: DeviceWs): DeviceSocket | undefined => owners.get(ws.data);
  // Bun's per-listener limits are fixed when it binds; the framework's frame limit is a constant.
  const { maxPayloadLength, idleTimeout } = current().websocket;
  return {
    path,
    fetch(request, server) {
      const link = current();
      const recording: DeviceUpgradeTarget = {
        upgrade(upgraded, options) {
          owners.set(options.data, link);
          return server.upgrade(upgraded, options);
        },
        requestIP: (asked) => server.requestIP(asked),
      };
      return link.fetch(request, recording);
    },
    websocket: {
      open: (ws) => ownerOf(ws)?.websocket.open(ws),
      message: (ws, message) => ownerOf(ws)?.websocket.message(ws, message),
      close: (ws) => ownerOf(ws)?.websocket.close(ws),
      maxPayloadLength,
      idleTimeout,
    },
  };
}

export async function hostDeviceSockets(
  transport: Transport,
  roles: readonly Role[],
): Promise<DeviceHosting> {
  const serve = roles.includes('web');
  const held = new Map<string, Held>();
  const attach = async (link: DeviceSocket): Promise<Held> => ({
    link,
    attachment: await link.attach({ transport, serve }),
  });
  const stopAll = (): void => {
    for (const entry of [...held.values()].reverse()) entry.attachment.stop();
  };
  try {
    for (const link of declaredDeviceSockets()) held.set(link.path, await attach(link));
  } catch (error) {
    stopAll();
    throw error;
  }
  const served = serve ? [...held.keys()] : [];
  // `held` replaces a served path's entry and never drops one; the boot's is the type's fallback.
  const mounts = serve
    ? [...held].map(([path, boot]) => pathMount(path, () => (held.get(path) ?? boot).link))
    : [];
  return {
    mounts,
    async refresh() {
      for (const link of declaredDeviceSockets()) {
        const was = held.get(link.path);
        if (was?.link === link) continue;
        // The new value takes the door BEFORE the old one sheds its sockets, so a device that
        // redials on the drain's `reconnect` frame reaches the edited handler.
        held.set(link.path, await attach(link));
        if (was === undefined) continue;
        // No spread and no grace: one developer's devices, and the save is waiting on it.
        await was.attachment.drain({ graceMs: 0, spreadMs: 0 });
        was.attachment.stop();
      }
      return serve
        ? declaredDeviceSockets()
            .map((link) => link.path)
            .filter((path) => !served.includes(path))
        : [];
    },
    async stop() {
      stopAll();
    },
  };
}
