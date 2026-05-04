/**
 * Helpers shared by both model clients to support
 * structured-output turns. The agent's structured-output design uses a
 * "synthetic tool" — when a caller supplies an `outputSchema`, we
 * append one extra `ToolSchema` to the tools list for the request.
 * The model decides to "call" that tool the same way it'd call any
 * other; we intercept the call in the response, validate the
 * arguments, and surface them as `ModelResponse.output` instead of
 * dispatching anything.
 *
 * This is kept provider-agnostic so the Anthropic and
 * OpenAI-compatible clients can share the wiring.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv/dist/2020.js";

import type {
  OutputSchema,
  ToolCall,
  ToolSchema,
} from "./types.js";
import { OutputValidationError } from "./types.js";

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const DEFAULT_DESCRIPTION =
  "Call this with your final answer once you have everything you need.";

let cachedAjv: Ajv2020 | null = null;
function getValidator(): Ajv2020 {
  if (!cachedAjv) {
    cachedAjv = new Ajv2020({ allErrors: true, strict: false });
  }
  return cachedAjv;
}

/**
 * Build the synthetic `ToolSchema` for a structured-output turn.
 * The schema is passed through verbatim — both providers accept
 * draft-2020-12 JSON Schema for tool input.
 */
export function synthesizeRespondTool(
  outputSchema: OutputSchema,
): ToolSchema {
  return {
    name: outputSchema.name,
    description: outputSchema.description ?? DEFAULT_DESCRIPTION,
    input_schema: outputSchema.schema,
  };
}

/**
 * Reject obvious problems early so we surface actionable errors
 * instead of letting the provider fail mid-request.
 */
export function validateOutputSchema(
  outputSchema: OutputSchema,
  realTools: ReadonlyArray<ToolSchema>,
): void {
  if (!outputSchema.name || !TOOL_NAME_PATTERN.test(outputSchema.name)) {
    throw new Error(
      `outputSchema.name must match ${TOOL_NAME_PATTERN}. Got "${outputSchema.name}".`,
    );
  }
  if (
    typeof outputSchema.schema !== "object" ||
    outputSchema.schema === null ||
    Array.isArray(outputSchema.schema)
  ) {
    throw new Error("outputSchema.schema must be a JSON Schema object.");
  }
  for (const tool of realTools) {
    if (tool.name === outputSchema.name) {
      throw new Error(
        `outputSchema.name "${outputSchema.name}" collides with a registered tool. Pick a different name.`,
      );
    }
  }
}

function formatPath(path: string): string {
  // Ajv's instancePath is "/items/0/price" style. Render as JSON-pointer
  // for the consumer; empty string means the root object.
  return path === "" ? "(root)" : path;
}

function ajvErrorsToFlat(
  errors: ReadonlyArray<ErrorObject> | null | undefined,
): Array<{ path: string; message: string }> {
  if (!errors) return [];
  return errors.map((e) => ({
    path: formatPath(e.instancePath ?? ""),
    message: e.message ?? "validation failed",
  }));
}

/**
 * Validate raw arguments against the output schema. Throws
 * `OutputValidationError` on mismatch; returns the parsed value on
 * success.
 */
export function validateOutput(
  outputSchema: OutputSchema,
  raw: unknown,
): unknown {
  const validator = getValidator();
  const validate = validator.compile(outputSchema.schema);
  if (validate(raw)) {
    return raw;
  }
  throw new OutputValidationError(
    `Structured output for "${outputSchema.name}" failed schema validation.`,
    raw,
    ajvErrorsToFlat(validate.errors),
  );
}

/**
 * Pull the synthetic respond tool's call (if any) out of the model's
 * response. Returns the validated parsed value plus a filtered
 * `toolCalls` list with the synthetic call removed so the agent loop
 * does not try to dispatch it.
 */
export function extractStructuredOutput(
  outputSchema: OutputSchema,
  toolCalls: ReadonlyArray<ToolCall>,
): { output: unknown; remainingToolCalls: ToolCall[] } | null {
  const idx = toolCalls.findIndex((c) => c.name === outputSchema.name);
  if (idx === -1) return null;
  const call = toolCalls[idx]!;
  const output = validateOutput(outputSchema, call.input);
  const remaining = toolCalls.filter((_, i) => i !== idx);
  return { output, remainingToolCalls: remaining };
}
