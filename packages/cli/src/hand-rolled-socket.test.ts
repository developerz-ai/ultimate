// An app's own websocket upgrade is refused: `deviceSocket()` is the one way an app serves a
// long-lived socket, so the auth before the handshake, the per-actor cap, the beat and the frame
// limit are never the app's to forget. The rule reads code, never a comment or a string.

import { describe, expect, test } from 'bun:test';
import { appBoundaryFindings } from './boundary-findings';
import { handRolledSocketFindings } from './hand-rolled-socket';

const file = (path: string, source: string) => ({ path, source });

describe('unit · handRolledSocketFindings', () => {
  test('a Bun.serve with a websocket handler set is refused, at its line', () => {
    const [finding, ...rest] = handRolledSocketFindings([
      file(
        'apps/web/app/devices/listener.ts',
        [
          "import { resolveDeviceToken } from './token';",
          '',
          'export const listener = Bun.serve({',
          '  port: 4000,',
          '  fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response(null)),',
          '  websocket: { message: () => undefined },',
          '});',
        ].join('\n'),
      ),
    ]);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_SOCKET_HAND_ROLLED');
    expect(finding?.at).toBe('apps/web/app/devices/listener.ts');
    expect(finding?.meta).toEqual({ line: 3 });
    expect(finding?.fix).toContain('deviceSocket({ path, resolveToken, onFrame })');
  });

  test('a server.upgrade( call is refused on its own, wherever the server came from', () => {
    const findings = handRolledSocketFindings([
      file(
        'apps/web/api/link.ts',
        'export const take = (request: Request, server: Server) =>\n  server.upgrade(request, { data: {} });\n',
      ),
    ]);
    expect(findings.map((finding) => [finding.at, finding.meta])).toEqual([
      ['apps/web/api/link.ts', { line: 2 }],
    ]);
  });

  test('an inline handler set handed to any server is refused', () => {
    const findings = handRolledSocketFindings([
      file(
        'apps/web/shared/socket.ts',
        'export const options = {\n  websocket: {\n    open() {},\n  },\n};\n',
      ),
    ]);
    expect(findings.map((finding) => finding.meta)).toEqual([{ line: 2 }]);
  });

  test('a deviceSocket declaration, an upgrade of some other thing, and prose pass', () => {
    expect(
      handRolledSocketFindings([
        file(
          'apps/web/app/devices/link.ts',
          "import { deviceSocket } from '@ultimat3/realtime/server';\nexport const deviceLink = deviceSocket({ path: '/link', resolveToken, onFrame });\n",
        ),
        file(
          'apps/web/app/orgs/service.ts',
          'export const move = (org: Org) => plans.upgrade(org, "team");\n',
        ),
        file(
          'apps/web/app/docs/page.tsx',
          "// we never call server.upgrade( ourselves\nexport const text = 'Bun.serve({ websocket: {} })';\n",
        ),
      ]),
    ).toEqual([]);
  });

  test('the boundaries step runs it over the app sources it read', async () => {
    const found = await appBoundaryFindings('/nowhere', [
      file(
        'apps/web/api/link.ts',
        'export const take = (r: Request, server: S) => server.upgrade(r);\n',
      ),
    ]);
    expect(found.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_SOCKET_HAND_ROLLED', 'apps/web/api/link.ts'],
    ]);
  });
});
