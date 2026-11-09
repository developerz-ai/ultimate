// Which durable step's body is running, ambient across its awaits. Read by an observer that must
// tell an effect made INSIDE a step (rerun when the step did not complete) from one made between
// steps (rerun on every replay): `@ultimat3/testing`'s crash proof names the step it ran in.

import { asyncContext } from '@ultimat3/core';

const scope = asyncContext<string>('a durable step body');

/** Run one step body with its name in flight. `steps.ts` is the one caller. */
export const inStep = <T>(name: string, body: () => T): T => scope.run(name, body);

/** The name of the step whose body is running here, or `undefined` outside every step body. */
export const currentStep = (): string | undefined => scope.get();
