/**
 * What a model reads when an IN-PROCESS tool refuses. The failure first: an app's own typed
 * refusal — a code, a cause, a fix, written for exactly this reader — reached the model as
 * "the tool failed inside the server; the details are withheld", because an app code nobody gave
 * an HTTP status reads as a 500 and a 500's cause is hidden. The model could not correct its call,
 * so it made the same one again. A tool projected from an exposed action keeps that rule: its
 * failure is disclosed exactly as MCP and a problem document disclose it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resetPublicCauses, UltimateError, userActor } from '@ultimat3/core';
import { driverError } from '@ultimat3/db';
import { registerErrorStatus, resetErrorStatus } from '@ultimat3/http';
import type { ProjectableAction } from './tools';
import { HIDDEN_TOOL_CAUSE, runLlmToolCall } from './tools';

const actor = userActor({ id: 'u-1' });

const refusal = () =>
  new UltimateError({
    code: 'X_KB_DOC_NOT_FOUND',
    cause: 'no knowledge-base document has the id "ley-2213-art-9"',
    fix: 'kbList({ topic })   # call it first and pass one of the ids it returns',
  });

const tool = (thrown: unknown, extra: Partial<ProjectableAction> = {}): ProjectableAction => ({
  name: 'kbRead',
  description: 'Read one knowledge-base document',
  mcp: { expose: true },
  run: () => Promise.reject(thrown),
  ...extra,
});

const reads = async (action: ProjectableAction) =>
  runLlmToolCall([action], { id: 'call-1', name: 'kbRead', input: { id: 'x' } }, actor);

afterEach(() => {
  resetErrorStatus();
  resetPublicCauses();
});

describe("an in-process tool's own refusal reaches the model", () => {
  test('as a structured error: the code, the cause and the fix — nothing else', async () => {
    const result = await reads(tool(refusal(), { inProcess: true }));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: {
        code: 'X_KB_DOC_NOT_FOUND',
        cause: 'no knowledge-base document has the id "ley-2213-art-9"',
        fix: 'kbList({ topic })   # call it first and pass one of the ids it returns',
      },
    });
    // Never a stack, a file path or a frame.
    expect(result.content).not.toContain('at ');
    expect(result.content).not.toContain('.ts');
  });

  test('the fix written for a remote caller wins over the developer one', async () => {
    const thrown = new UltimateError({
      code: 'X_KB_DOC_NOT_FOUND',
      cause: 'no such document',
      fix: 'x queries list --json   # look for the row',
      callerFix: 'call kbList first',
    });
    const result = await reads(tool(thrown, { inProcess: true }));
    expect(JSON.parse(result.content)).toMatchObject({ error: { fix: 'call kbList first' } });
    expect(result.content).not.toContain('x queries list');
  });
});

describe('what an in-process tool still withholds', () => {
  test('a throw that is not a typed refusal: nothing of its message', async () => {
    const result = await reads(
      tool(new TypeError("Cannot read properties of undefined (reading 'password_hash')"), {
        inProcess: true,
      }),
    );
    expect(result).toMatchObject({ content: 'tool failed', isError: true });
  });

  test("a framework 5xx — a driver's statement failure — is not the app's refusal", async () => {
    const thrown = driverError('select password_hash from x_users', {
      code: '42P99',
      message: 'column "password_hash" does not exist',
    });
    const result = await reads(tool(thrown, { inProcess: true }));
    expect(result.content).toBe(`X_DB_STATEMENT_FAILED: ${HIDDEN_TOOL_CAUSE}`);
    expect(result.content).not.toContain('password_hash');
  });

  test('a code the app itself registered as a server fault', async () => {
    registerErrorStatus({ X_KB_DOC_NOT_FOUND: 503 });
    const result = await reads(tool(refusal(), { inProcess: true }));
    expect(result.content).toContain(HIDDEN_TOOL_CAUSE);
  });

  test('a look-alike: only an error built in this process is a typed refusal', async () => {
    const foreign = { code: 'X_KB_DOC_NOT_FOUND', cause: 'secret', fix: 'curl evil' };
    const result = await reads(tool(foreign, { inProcess: true }));
    expect(result.content).toBe(`X_KB_DOC_NOT_FOUND: ${HIDDEN_TOOL_CAUSE}`);
  });

  test('everything, when the tool opts out', async () => {
    const result = await reads(tool(refusal(), { inProcess: true, discloseErrors: false }));
    expect(result.content).toBe(`X_KB_DOC_NOT_FOUND: ${HIDDEN_TOOL_CAUSE}`);
  });
});

describe('a tool projected from an exposed action keeps the rule MCP follows', () => {
  test('the same refusal, with no status row, is still withheld', async () => {
    const result = await reads(tool(refusal()));
    expect(result.content).toBe(`X_KB_DOC_NOT_FOUND: ${HIDDEN_TOOL_CAUSE}`);
  });

  test('and shown, in the line format it always had, once the app gives the code a 4xx', async () => {
    registerErrorStatus({ X_KB_DOC_NOT_FOUND: 404 });
    const result = await reads(tool(refusal()));
    expect(result.content).toBe(
      'X_KB_DOC_NOT_FOUND: no knowledge-base document has the id "ley-2213-art-9" (fix: kbList({ topic })   # call it first and pass one of the ids it returns)',
    );
  });
});
