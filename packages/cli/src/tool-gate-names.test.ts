// A gate naming no real tool fails open: `tools: ['refundOrdr']` protects nothing, and the agent's
// `refundOrder` runs with nobody asked. `defineAppMcp` refuses that at boot only for a server handed
// the gate, so this is the build error for every other layout.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  action,
  noteToolNames,
  registerAction,
  registerToolGate,
  resetActions,
} from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { unknownToolGateFindings } from './tool-gate-names';

afterEach(() => resetActions());

const pass = (_call: unknown, run: () => Promise<unknown>) => run();

const exposed = (expose: boolean) =>
  action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    mcp: { expose },
    handle: () => ({ ok: true }),
  });

const loaded = () => async () => ({ findings: [] });

describe('unknownToolGateFindings', () => {
  test('a gate naming no real tool is X_MCP_CONFIRMATION_TOOL_UNKNOWN, naming what does exist', async () => {
    registerAction('refundOrder', exposed(true));
    registerToolGate(['refundOrdr'], pass);
    const findings = await unknownToolGateFindings('/app', loaded());
    expect(findings.map((one) => one.code)).toEqual(['X_MCP_CONFIRMATION_TOOL_UNKNOWN']);
    expect(findings[0]?.cause).toContain('refundOrdr');
    expect(findings[0]?.fix).toContain('refundOrder');
  });

  test('an exposed action is a tool', async () => {
    registerAction('refundOrder', exposed(true));
    registerToolGate(['refundOrder'], pass);
    expect(await unknownToolGateFindings('/app', loaded())).toEqual([]);
  });

  test('an action no agent can be offered is not: its gate protects nothing', async () => {
    registerAction('refundOrder', exposed(false));
    registerToolGate(['refundOrder'], pass);
    const findings = await unknownToolGateFindings('/app', loaded());
    expect(findings.map((one) => one.code)).toEqual(['X_MCP_CONFIRMATION_TOOL_UNKNOWN']);
  });

  test('a noted tool (an MCP hand-written one, an agent in-process one) is a tool', async () => {
    noteToolNames(['seatReport']);
    registerToolGate(['seatReport'], pass);
    expect(await unknownToolGateFindings('/app', loaded())).toEqual([]);
  });

  test('a failed load says nothing: a short registry is reported by the load', async () => {
    registerToolGate(['refundOrdr'], pass);
    const failed = async () => ({
      findings: [{ code: 'X_APP_LOAD', cause: 'c', fix: 'f' }],
    });
    expect(await unknownToolGateFindings('/app', failed)).toEqual([]);
  });
});
