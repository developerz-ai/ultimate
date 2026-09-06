// Single responsibility: which record keys reach an object's prototype instead of its own
// properties. One definition, because the rule that REFUSES a key (`validators.ts`) and the
// document that PUBLISHES the refusal (`json-schema.ts`) must name the same closed set — the same
// reason `char-count.ts` owns the unit a length is counted in.

/**
 * A record's keys are the caller's, so `{"__proto__":{…}}` on a `{}` literal set the OUTPUT's
 * prototype: `Object.keys` answered `[]` while `settings[k] ?? fallback` handed a handler the
 * attacker's value for a key that was never sent. `recordSchema` refuses these by name AND builds
 * on a null prototype — the null prototype alone would keep `__proto__` as a silent own key nobody
 * declared — and `json-schema.ts` emits them as a `propertyNames` constraint, so OpenAPI, the
 * typed client and an MCP tool schema advertise exactly what the boundary accepts rather than
 * promising keys it answers with a 422.
 */
export const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The membership test the parser applies. A list is what the projection publishes; this is the
 * same fact asked the other way, so neither side builds its own `Set`. */
export const isPrototypeKey = (key: string): boolean => PROTOTYPE_KEYS.includes(key);
