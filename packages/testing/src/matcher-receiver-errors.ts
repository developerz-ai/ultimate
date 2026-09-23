// Single responsibility: the refusals three matchers give a receiver of the wrong TYPE. Thrown,
// never `pass: false` — under `.not` a `pass: false` is a pass, so `.not.toDenyPolicy` held on
// `undefined`. Its own module because `errors.ts` sits at the size ceiling; the codes are
// registered there, beside every other testing code.

import { describeValue, UltimateError } from '@ultimat3/core';

/** `toDenyPolicy` handed something with neither `run()` nor `evaluate()`. */
export class TestPolicyExpectedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_POLICY_EXPECTED',
      cause: `toDenyPolicy expects a policy — an object with run() (@ultimat3/policy) or evaluate() — and received ${describeValue(received)}`,
      fix: "expect(post.policy).toDenyPolicy(ctx) — pass the policy object (@ultimat3/policy's, with run() or evaluate()), never the action or its result",
    });
  }
}

/** `toMatchOpenApi` handed something that is not a generated document. */
export class TestOpenApiExpectedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_OPENAPI_EXPECTED',
      cause: `toMatchOpenApi expects an OpenAPI document — an object with operations: [{ operationId, required? }] — and received ${describeValue(received)}`,
      fix: 'expect(await app.openapi()).toMatchOpenApi(committed) — the receiver is the generated document: an object with operations: [{ operationId, required? }]',
    });
  }
}

/** `toBeWithinBudget` handed something that is not a finite number. */
export class TestNumberExpectedError extends UltimateError {
  constructor(received: unknown) {
    super({
      code: 'X_TEST_NUMBER_EXPECTED',
      cause: `toBeWithinBudget expects a finite number to compare against the budget, and received ${describeValue(received)}`,
      fix: 'expect(bytes).toBeWithinBudget(limit) — pass the measured number itself, e.g. (await Bun.file(path).arrayBuffer()).byteLength, never a Promise or a string',
    });
  }
}
