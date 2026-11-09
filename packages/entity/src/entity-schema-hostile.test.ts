// `$schema` over a column parser that throws something hostile: one issue, never a second throw.
// Split from `entity.test.ts` at its line ceiling.
import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

/**
 * `$schema` answers with `issues`; it does not throw. The line that built the issue message read
 * the caught value directly — `error instanceof Error ? error.message : String(error)` — and both
 * halves are reads a throwable can refuse (`instanceof` consults `getPrototypeOf`, `String()` runs
 * the value's own coercion). A column's `$parse` is app code, so a null-prototype throwable or a
 * `Proxy` out of one raised a second, uncatchable `TypeError` from inside validation, where a
 * rejection belongs. `renderThrowable` is total.
 */
describe('$schema over a column parser that throws a hostile value', () => {
  const entityWhoseTitleThrows = (suffix: string, thrown: unknown) =>
    entity(`entity_test_hostile_${suffix}`, {
      columns: {
        id: uuid().primaryKey(),
        title: {
          ...text(),
          $parse: (): never => {
            throw thrown;
          },
        },
      },
    });

  const issuesFor = (suffix: string, thrown: unknown): readonly { message: string }[] => {
    const result = entityWhoseTitleThrows(suffix, thrown).$schema['~standard'].validate({
      id: '00000000-0000-7000-8000-0000000000ff',
      title: 'anything',
    });
    expect(result).not.toBeInstanceOf(Promise);
    return result instanceof Promise
      ? []
      : (result.issues ?? []).map((issue) => ({
          message: String(issue.message),
        }));
  };

  test('a null-prototype throwable becomes one issue, never a second throw', () => {
    expect(
      issuesFor('null_proto', Object.assign(Object.create(null), { nope: true })),
    ).toHaveLength(1);
  });

  test('a Proxy that refuses every read becomes one issue too', () => {
    const hostile = new Proxy(
      {},
      {
        get: (): never => {
          throw new TypeError('no reads');
        },
        getPrototypeOf: (): never => {
          throw new TypeError('no prototype either');
        },
      },
    );
    expect(issuesFor('proxy', hostile)).toHaveLength(1);
  });

  test('an ordinary Error still says what it said, and names its kind', () => {
    const message = issuesFor('plain', new TypeError('title is not a string'))[0]?.message ?? '';
    expect(message).toContain('title is not a string');
    expect(message).toContain('TypeError');
  });
});
