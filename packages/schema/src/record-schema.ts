// Single responsibility: `t.record(values)` — a map of caller-chosen keys to one value schema.
// Its own file because a record key is CALLER data, unlike every other path segment, and the rules
// that follow from that (position paths, refused keys) are the whole of it.

import {
  type AnySchema,
  checkOf,
  failWith,
  isPlainObject,
  makeSchema,
  mistyped,
  pass,
  type Schema,
} from './builder';
import { expected } from './describe-value';
import { stopCollecting } from './issue-cap';
import type { SchemaNode } from './node';
import { isPrototypeKey, PROTOTYPE_KEYS } from './prototype-keys';
import type { InferInput, InferOutput, StandardIssue } from './standard';
import { unstorable } from './unstorable-text';

export function recordSchema<S extends AnySchema>(
  values: S,
): Schema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>> {
  const valueCheck = checkOf(values);
  const node: SchemaNode = { kind: 'record', valueNode: values.node };
  return makeSchema<Readonly<Record<string, InferInput<S>>>, Record<string, InferOutput<S>>>(
    node,
    (value, path) => {
      if (!isPlainObject(value))
        return mistyped(path, expected('an object', value), value, 'record');
      const issues: StandardIssue[] = [];
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const entries = Object.entries(value);
      for (const [index, [key, entry]] of entries.entries()) {
        // At the issue cap the rest is not read (`issue-cap.ts`): a 10k-key body is a hundred.
        if (stopCollecting(issues.length, true)) break;
        // The entry's POSITION, never its key. `describe-value.ts`'s absolute is stated about the
        // rejected value, and a record's KEY is the caller's data just as much: the path travels
        // `formatIssue` -> `bodyInvalid`'s `cause` -> the problem document AND the log line, and
        // core's logger redacts by key, so a key baked into a string has no key left to redact.
        // `@ultimat3/http`'s `bodyInvalid` states the contract this was breaking in its own doc
        // block — *"`issues` … must name only facts the framework itself chose"*. A record keyed
        // by an email address, a phone number or a pasted credential wrote every one of them into
        // the central log index, in the same shape the password bug did.
        //
        // The index rather than nothing at all: the segment's whole job is to say WHICH entry
        // failed, and dropping it makes three failing entries render three identical lines. It is
        // the same segment `arraySchema` already uses, so `formatPath` renders `meta[3]` with no
        // new spelling to learn. It is `Object.entries` order — integer-like keys sort ahead of
        // string ones — so it names an entry that exists rather than a byte offset in the body.
        const at = [...path, index];
        // A record is stored as `jsonb` far more often than not, and jsonb refuses an unstorable
        // KEY exactly as it does a value — so the key is refused here, by position, not quoted.
        const unfitKey = unstorable(key);
        if (unfitKey !== undefined) {
          issues.push({
            message: `expected a record key, received one ${unfitKey}`,
            path: at,
            rule: 'record.key',
          });
          continue;
        }
        if (isPrototypeKey(key)) {
          issues.push({
            // The refused NAMES are a closed set declared right here, so the message may state
            // them: that is the one part of this line the caller did not choose.
            message: expected(`a record key that is not ${PROTOTYPE_KEYS.join(' | ')}`, key),
            path: at,
            rule: 'record.key',
          });
          continue;
        }
        const result = valueCheck(entry, at);
        if (result.ok) out[key] = result.value;
        else issues.push(...result.issues);
      }
      if (issues.length > 0) return failWith(issues);
      return pass(out as Record<string, InferOutput<S>>);
    },
  );
}
