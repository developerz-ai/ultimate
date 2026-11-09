// Single responsibility: the refusals of the test-double surface — `stub()`, `swapAdapter()` and
// the matchers that read them. The codes are registered in `errors.ts`, beside every other testing
// code; the classes live here because that catalogue is at its size ceiling.

import { describeValue, renderCauseValue, UltimateError } from '@ultimat3/core';

/** A double made where no preload will ever put it back. */
export class TestScopeUninstalledError extends UltimateError {
  constructor(what: string) {
    super({
      code: 'X_TEST_SCOPE_UNINSTALLED',
      cause: `${what} was made in a process the testing preload did not set up, so nothing would put it back and it would answer for every later file on the worker`,
      fix: `printf '\\n[test]\\npreload = ["@ultimat3/testing/preload"]\\n' >> bunfig.toml — or, when bunfig.toml already has a [test] table, add that preload line to it`,
    });
  }
}

/** The body is stubbed and nobody said what it answers. */
export class TestStubUnansweredError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_TEST_STUB_UNANSWERED',
      cause: `"${name}" is stubbed and was called before .returns() or .throws() scripted an answer`,
      fix: `const stubbed = await stub(${name || 'target'}); stubbed.returns(<output>) — or .throws(new YourError(...)) — before the code under test runs`,
    });
  }
}

/** `stub()` handed something no seam can replace. */
export class TestStubTargetUnsupportedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_STUB_TARGET_UNSUPPORTED',
      cause: `stub() replaces the body of an action, an llm(), a query or a job, and received ${describeValue(received)}`,
      fix: 'await stub(publishPost) — pass the action, llm(), query or job your module exports, never its result or its name',
    });
  }
}

/** The expected input of an assertion is one no call could ever have carried. */
export class TestExpectedInputInvalidError extends UltimateError {
  constructor(matcher: string, name: string, issues: unknown) {
    super({
      code: 'X_TEST_EXPECTED_INPUT_INVALID',
      cause: `${matcher} parses the expected input through "${name}"'s input schema, and it was refused: ${renderCauseValue(issues)}`,
      fix: `${matcher}(<an input "${name}"'s input schema accepts>) — correct the field the issues name`,
    });
  }
}

/** `toHaveEnqueued` on something that is not the queue a test owns. */
export class TestRunJobsExpectedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_RUN_JOBS_EXPECTED',
      cause: `toHaveEnqueued reads the runJobs fixture's queue, and received ${describeValue(received)}`,
      fix: 'unitTest(..., async ({ runJobs }) => { ...; await expect(runJobs).toHaveEnqueued(sendWelcome, { userId }); })',
    });
  }
}

/** `toHaveSentMail` on something that is not the outbox a test owns. */
export class TestMailExpectedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_MAIL_EXPECTED',
      cause: `toHaveSentMail reads the mail fixture's outbox, and received ${describeValue(received)}`,
      fix: 'unitTest(..., async ({ mail }) => { ...; expect(mail).toHaveSentMail(welcomeMail, { to: address }); })',
    });
  }
}

/** `swapAdapter()` named a port with no process-global slot, or no port at all. */
export class TestAdapterPortUnswappableError extends UltimateError {
  constructor(port: string, instead: Readonly<Record<string, string>>) {
    const known = Object.hasOwn(instead, port) ? instead[port] : undefined;
    super({
      code: 'X_TEST_ADAPTER_PORT_UNSWAPPABLE',
      cause:
        known === undefined
          ? `"${port}" is no ADAPTER_PORTS row (@ultimat3/core)`
          : `"${port}" has no process-global slot a test could borrow: ${known}`,
      fix: `await swapAdapter('jobs', memoryJobDriver()) — name a port SwappablePort lists, or for "${port}": ${known ?? 'pick a row of ADAPTER_PORTS'}`,
    });
  }
}
