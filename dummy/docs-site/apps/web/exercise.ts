// What `x exercise` cannot guess about this app: an input a primitive needs bound to a real
// row, an actor its policy permits, or a primitive that must not run in the pass and why. Empty
// runs every action, query and job as generated. `x exercise --json` prints the entry to paste
// for each one it could not reach; each value is the `exercise` option `.contract()` takes.
import { defineExercise } from '@ultimat3/testing';

/** Every page reads the wiki's markdown off disk at build time: the app has no table at all. */
const FROM_DISK =
  'renders a wiki page read from disk: the docs site has no database read to measure';

export const exercise = defineExercise(
  {
    health: {
      off: 'the readiness probe answers its own role and reads nothing: no statement, no effect, so every proof over it is vacuous',
    },
  },
  {
    routes: {
      '/:page': { empty: FROM_DISK },
      '/errors/:code': { empty: FROM_DISK },
      '/upgrading/:major': { empty: FROM_DISK },
    },
  },
);
