#!/usr/bin/env bun
// Generate `packages/realtime/wire/device-v1.json` from the typed fixture table, and refuse a
// committed file that has drifted from it. The JSON ships in the tarball for non-JS device clients.
//
// A device agent in another language cannot import `device-wire-frames.ts`; it can load this file
// and prove its own reader against every frame, rejected ones included.
//
//   bun run scripts/device-wire.ts [--check | --write] [--json]

// why: host-separator paths to the generated file; Bun ships no path API.
import { join } from 'node:path';
import { DEVICE_FRAME_MAX_BYTES, DEVICE_WIRE_VERSION } from '../packages/realtime/src/device-wire';
import { DEVICE_WIRE_FIXTURES } from '../packages/realtime/src/device-wire-frames';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'device-wire';
export const DEVICE_WIRE_FILE = 'packages/realtime/wire/device-v1.json';
const FIX = 'bun run scripts/device-wire.ts --write';

/** The file's exact text: stable key order, two-space indent, one trailing newline. */
export function renderDeviceWire(): string {
  return `${JSON.stringify(
    {
      version: DEVICE_WIRE_VERSION,
      maxFrameBytes: DEVICE_FRAME_MAX_BYTES,
      fixtures: DEVICE_WIRE_FIXTURES,
    },
    null,
    2,
  )}\n`;
}

/** The finding for a committed file's text, none when it is the generated one. */
export function deviceWireDrift(committed: string): readonly Finding[] {
  if (committed === renderDeviceWire()) return [];
  return [
    {
      code: 'X_DEVICE_WIRE_DRIFT',
      cause: `${DEVICE_WIRE_FILE} does not match the fixture table in packages/realtime/src/device-wire-frames.ts it is generated from`,
      fix: FIX,
      at: DEVICE_WIRE_FILE,
    },
  ];
}

export async function deviceWireFindings(root: string): Promise<readonly Finding[]> {
  const file = Bun.file(join(root, DEVICE_WIRE_FILE));
  return deviceWireDrift((await file.exists()) ? await file.text() : '');
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    await Bun.write(join(root, DEVICE_WIRE_FILE), renderDeviceWire());
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: `${DEVICE_WIRE_FILE} written — ${DEVICE_WIRE_FIXTURES.length} fixtures`,
      },
      args.json,
    );
  }
  const findings = await deviceWireFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0 ? `${DEVICE_WIRE_FILE} matches the fixtures` : 'device wire drift',
      findings,
    },
    args.json,
  );
}
