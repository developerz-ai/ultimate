// `X_TEST_MODULE_MOCK_UNRESTORABLE`'s message: which file mocked which module whose real source
// could not be loaded for its snapshot. The CODE is registered in `errors.ts`; the boundary that
// raises it is `module-mock-boundary.ts`. Every value here is uncontrolled, so it is rendered.

import { renderCauseValue, renderThrowable, UltimateError } from '@ultimat3/core';

export interface UnrestorableMock {
  /** The test file that called `mock.module`. */
  readonly file: string;
  /** The module it mocked, as resolved (or as written, when it did not resolve). */
  readonly url: string;
  /** Why the real module could not be snapshotted. */
  readonly reason: unknown;
}

export class ModuleMockUnrestorableError extends UltimateError {
  constructor(mocks: readonly UnrestorableMock[]) {
    const each = mocks.map(
      (mock) =>
        `${renderCauseValue(mock.file)} mocked ${renderCauseValue(mock.url)}, whose real module failed to load (${renderThrowable(mock.reason)})`,
    );
    super({
      code: 'X_TEST_MODULE_MOCK_UNRESTORABLE',
      cause: `${each.join('; ')} — so nothing could be put back, and this file on the same worker saw the fake`,
      fix: 'x test unit --isolate   # or hand the mocked dependency to the code under test as a parameter, so no module is mocked',
    });
  }
}
