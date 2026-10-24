import { parse, type Node } from "acorn";
import { Script } from "node:vm";

export const MAX_SCRIPT_CHARS = 512 * 1024;

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface ParsedScript {
  meta: WorkflowMeta;
  /** The script with the meta statement blanked out, line numbers preserved. */
  body: string;
}

export class ScriptError extends Error {
  override name = "ScriptError";
}

// biome-ignore lint/suspicious/noExplicitAny: acorn's ESTree nodes are loosely typed.
type AnyNode = Node & { [key: string]: any };

const NONDETERMINISM =
  "Workflow scripts must be deterministic: Date.now(), Math.random() and argless new Date() are unavailable because they break resume. Pass timestamps in through args, stamp results after the workflow returns, and vary prompts or labels by index instead of randomness.";

const PLAIN_JS = "The script must be plain JavaScript. The usual causes are TypeScript syntax (type annotations, interfaces, generics) and a string whose quotes are unbalanced or unescaped.";
const TS_HINT = " This one looks like TypeScript: remove the type annotations, interfaces and generics.";

/** The offending line (clipped around the column) with a caret under the error position. */
function codeFrame(source: string, line: number, column: number): string {
  const text = source.split("\n")[line - 1] ?? "";
  const start = Math.max(0, column - 60);
  const shown = text.slice(start, start + 120);
  return `${start > 0 ? "…" : ""}${shown}\n${" ".repeat(column - start + (start > 0 ? 1 : 0))}^`;
}

export function parseWorkflowScript(source: string): ParsedScript {
  if (typeof source !== "string" || !source.trim()) throw new ScriptError("The workflow script is empty.");
  if (source.length > MAX_SCRIPT_CHARS) {
    throw new ScriptError(`The workflow script is too large (${source.length} characters; at most ${MAX_SCRIPT_CHARS}).`);
  }
  let ast: AnyNode;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as AnyNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    throw new ScriptError(`Script parse error: ${message}${loc ? `\n\n${codeFrame(source, loc.line, loc.column)}` : ""}\n\n${PLAIN_JS}${looksLikeTypeScript(source) ? TS_HINT : ""}`);
  }

  const statements = ast.body as AnyNode[];
  const first = statements[0];
  const metaInit = metaInitializer(first);
  const meta = validateMeta(literalValue(metaInit, "meta"));

  for (const statement of statements.slice(1)) {
    if (statement.type === "ImportDeclaration") {
      throw new ScriptError("Workflow scripts cannot import modules: there is no filesystem or Node.js API access. Use agent() for work that needs tools.");
    }
    if (statement.type.startsWith("Export")) {
      throw new ScriptError("Only `export const meta = {...}` may be exported; the rest of the script is the body that runs.");
    }
  }
  walk(ast, (node) => {
    if (isCall(node, "Date", "now") || isCall(node, "Math", "random")) throw new ScriptError(NONDETERMINISM);
    if (node.type === "NewExpression" && isIdentifier(node.callee, "Date") && node.arguments.length === 0) {
      throw new ScriptError(NONDETERMINISM);
    }
    if (node.type === "CallExpression" && isIdentifier(node.callee, "Date")) throw new ScriptError(NONDETERMINISM);
    if (node.type === "ImportExpression") {
      throw new ScriptError("Workflow scripts cannot import modules: dynamic import() is unavailable.");
    }
  });

  const blank = source.slice(first.start, first.end).replace(/[^\n]/g, " ");
  const body = source.slice(0, first.start) + blank + source.slice(first.end);
  try {
    new Script(`(async function () {\n'use strict';\n${body}\n})`, { filename: `${meta.name}.workflow.js`, lineOffset: -2 });
  } catch (error) {
    throw new ScriptError(`Script compile error: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return { meta, body };
}

function metaInitializer(first: AnyNode | undefined): AnyNode {
  const shape = "The script must begin with `export const meta = { name, description, phases }` (a pure literal).";
  if (!first || first.type !== "ExportNamedDeclaration" || !first.declaration) throw new ScriptError(shape);
  const declaration = first.declaration as AnyNode;
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) {
    throw new ScriptError(shape);
  }
  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta" || !declarator.init) throw new ScriptError(shape);
  return declarator.init as AnyNode;
}

function literalValue(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const property of node.properties as AnyNode[]) {
        if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method) {
          throw new ScriptError(`meta must be a pure literal: ${path} may only contain plain properties.`);
        }
        const key = propertyKey(property.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new ScriptError(`meta must be a pure literal: reserved key ${path}.${key}.`);
        }
        out[key] = literalValue(property.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element || element.type === "SpreadElement") {
          throw new ScriptError(`meta must be a pure literal: ${path}[${index}] is a hole or a spread.`);
        }
        return literalValue(element, `${path}[${index}]`);
      });
    case "Literal":
      if (node.regex || typeof node.value === "bigint") throw new ScriptError(`meta must be a pure literal: ${path} is not JSON.`);
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) {
        throw new ScriptError(`meta must be a pure literal: ${path} uses template interpolation.`);
      }
      return (node.quasis as AnyNode[]).map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      break;
  }
  throw new ScriptError(`meta must be a pure literal: ${path} is ${node.type}, not a literal (no variables, calls, spreads or interpolation).`);
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  throw new ScriptError(`meta must be a pure literal: unsupported key in ${path}.`);
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScriptError("meta must be an object literal.");
  const meta = value as Record<string, unknown>;
  if (typeof meta.name !== "string" || !meta.name.trim()) throw new ScriptError("meta.name must be a non-empty string.");
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    throw new ScriptError("meta.description must be a non-empty string.");
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") throw new ScriptError("meta.whenToUse must be a string.");
  const result: WorkflowMeta = { name: meta.name.trim(), description: meta.description.trim() };
  if (typeof meta.whenToUse === "string") result.whenToUse = meta.whenToUse;
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new ScriptError("meta.phases must be an array of { title, detail? }.");
    result.phases = meta.phases.map((phase, index) => {
      if (typeof phase === "string") return { title: phase };
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new ScriptError(`meta.phases[${index}] must be { title: string, detail?: string }.`);
      }
      const { title, detail, model } = phase as Record<string, unknown>;
      if (detail !== undefined && typeof detail !== "string") throw new ScriptError(`meta.phases[${index}].detail must be a string.`);
      if (model !== undefined && typeof model !== "string") throw new ScriptError(`meta.phases[${index}].model must be a string.`);
      return {
        title: title as string,
        ...(typeof detail === "string" ? { detail } : {}),
        ...(typeof model === "string" ? { model } : {}),
      };
    });
  }
  return result;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function isNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isIdentifier(node: AnyNode | undefined, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

function isCall(node: AnyNode, object: string, property: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AnyNode;
  if (callee?.type !== "MemberExpression" || !isIdentifier(callee.object, object)) return false;
  if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name === property;
  return callee.property?.type === "Literal" && callee.property.value === property;
}

function looksLikeTypeScript(source: string): boolean {
  return /\binterface\s+\w+\s*\{|:\s*(string|number|boolean|any|unknown)(\[\])?\s*[,)=;]|\btype\s+\w+\s*=|<\w+>\(/.test(source);
}
