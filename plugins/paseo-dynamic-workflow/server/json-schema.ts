import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";

export class SchemaError extends Error {
  override name = "SchemaError";
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const cache = new Map<string, ValidateFunction>();

export interface CompiledSchema {
  schema: Record<string, unknown>;
  validate(value: unknown): string[];
}

/**
 * Validates an agent() schema up front: a JSON Schema object with `type: "object"` and
 * `properties` at the root, and `required` naming only declared properties. Unsatisfiable schemas
 * throw here, at the agent() call, rather than after an agent has run.
 */
export function compileSchema(schema: unknown): CompiledSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SchemaError("agent() opts.schema must be a JSON Schema object");
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" || !root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    throw new SchemaError("agent() opts.schema needs {type: 'object', properties: {...}} at the root");
  }
  if (root.required !== undefined) {
    if (!Array.isArray(root.required) || root.required.some((key) => typeof key !== "string")) {
      throw new SchemaError("agent() opts.schema.required must be an array of property names");
    }
    const missing = (root.required as string[]).filter((key) => !(key in (root.properties as object)));
    if (missing.length > 0) {
      throw new SchemaError(`agent() opts.schema.required names properties that are not declared: ${missing.join(", ")}`);
    }
  }
  const key = JSON.stringify(root);
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(root);
    } catch (error) {
      throw new SchemaError(`agent() opts.schema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, validate);
  }
  const compiled = validate;
  return {
    schema: root,
    validate(value) {
      if (compiled(value)) return [];
      return (compiled.errors ?? []).slice(0, 12).map((error) => {
        const where = error.instancePath || "(root)";
        const extra =
          error.keyword === "additionalProperties" && "additionalProperty" in error.params
            ? ` (${String(error.params.additionalProperty)})`
            : error.keyword === "enum" && "allowedValues" in error.params
              ? ` (${JSON.stringify(error.params.allowedValues)})`
              : "";
        return `${where}: ${error.message ?? error.keyword}${extra}`;
      });
    },
  };
}

/**
 * Pulls the JSON value out of a final message: the whole text, a fenced block, or the last
 * balanced object in it. Returns undefined when nothing parses.
 */
export function extractJson(text: string | null | undefined): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const fences = [...trimmed.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/g)];
  for (let index = fences.length - 1; index >= 0; index--) {
    const parsed = tryParse(fences[index]?.[1]?.trim() ?? "");
    if (parsed !== undefined) return parsed;
  }
  for (let end = trimmed.lastIndexOf("}"); end >= 0; end = trimmed.lastIndexOf("}", end - 1)) {
    const start = matchingOpen(trimmed, end);
    if (start === null) continue;
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  if (!text || (text[0] !== "{" && text[0] !== "[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Index of the `{` that balances the `}` at `end`, skipping string contents. */
function matchingOpen(text: string, end: number): number | null {
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    if (balanced(text, start, end)) return start;
  }
  return null;
}

function balanced(text: string, start: number, end: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = start; index <= end; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return index === end;
      if (depth < 0) return false;
    }
  }
  return false;
}
