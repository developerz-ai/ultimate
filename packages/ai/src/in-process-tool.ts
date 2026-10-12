// Single responsibility: `inProcessTool()` — a tool that exists only for an agent in this
// process. A name, a description, an input schema and an `execute`; nothing an MCP surface, an
// HTTP route, `openapi.json` or the manifest ever sees.
//
// Not a ninth primitive and not an action: it is a function the agent's own action may call, as
// code in that action's `handle` would be. The AGENT is the operation with a policy; this runs as
// `ctx.actor` inside it, and anything it reaches that needs its own authorization is an `action()`
// it calls — whose policy then decides, as always.
//
// It exists because the other way to give an agent a tool was to declare an action
// `mcp: { expose: true }` — the same flag that serves it to every external MCP client. A tool that
// must never be an MCP tool had to claim it was one.

import { InputInvalidError } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toWireSchema, validateAsync } from '@ultimat3/schema';
import { AiRequestInvalidError } from './errors';
import { RESPOND } from './respond';
import type { ProjectableAction } from './tools';

export interface InProcessToolDef<TInput extends StandardSchemaV1> {
  /** What the model calls it. Letters, digits, `_` and `-`, at most 64 — what every provider takes. */
  readonly name: string;
  /** What the model reads to decide when to call it. Required: a tool with none is never chosen well. */
  readonly description: string;
  /** Parses what the model sent before `execute` sees it; projected as the tool's input schema. */
  readonly input: TInput;
  /**
   * Runs as the request's own actor — never one the model named. Throw an `UltimateError` to refuse:
   * its code, cause and fix are what the model reads (`discloseErrors`).
   */
  execute(args: { readonly input: InferOutput<TInput>; readonly actor: Actor }): unknown;
  /** `false` withholds this tool's refusals from the model as a projected tool's are. Default `true`. */
  readonly discloseErrors?: boolean;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A tool for `agent({ tools })` that is this process's alone. Declared once, at module scope. */
export function inProcessTool<TInput extends StandardSchemaV1>(
  def: InProcessToolDef<TInput>,
): ProjectableAction {
  if (!NAME.test(def.name) || def.name === RESPOND) {
    throw new AiRequestInvalidError({
      detail: `inProcessTool() was given the name ${JSON.stringify(def.name)}; a tool name is 1 to 64 letters, digits, "_" or "-", and "${RESPOND}" is the answer tool's`,
      fix: "inProcessTool({ name: 'kbRead', … })   # letters, digits, _ and - only",
    });
  }
  if (def.description.trim() === '') {
    throw new AiRequestInvalidError({
      detail: `inProcessTool("${def.name}") has an empty description, and the description is all the model has to decide when to call it`,
      fix: `inProcessTool({ name: '${def.name}', description: 'Read one document by id.', … })`,
    });
  }
  return {
    name: def.name,
    description: def.description,
    // A schema the wire cannot express throws HERE, at declaration — as `respondFor`'s does.
    inputJsonSchema: toWireSchema(def.input),
    inProcess: true,
    ...(def.discloseErrors === undefined ? {} : { discloseErrors: def.discloseErrors }),
    async run({ input, actor }) {
      const parsed = await validateAsync(def.input, input);
      if (parsed.issues !== undefined) {
        // The line only: the structured issues are `@ultimat3/action`'s own shape, for a form.
        throw new InputInvalidError(
          def.name,
          formatIssues(parsed.issues).join('; '),
          undefined,
          'tool',
        );
      }
      return def.execute({ input: parsed.value, actor });
    },
  };
}
