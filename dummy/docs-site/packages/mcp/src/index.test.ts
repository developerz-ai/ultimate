// The catalog is built where it is called, from whatever has registered by then: this file loads no
// app, so what it pins is the shape. The tools themselves are the contract test's, next door.
import { expect, unitTest } from '@ultimat3/testing';
import { appMcp } from './index';

unitTest('the catalog is in process until a token resolver is given', () => {
  // No `resolveToken` means no route: a mount with no bearer check is the failure this rules out.
  expect(appMcp().route).toBeUndefined();
});

unitTest('given one, it is a route at /mcp', () => {
  expect(appMcp({ resolveToken: () => null }).route?.path).toBe('/mcp');
});
