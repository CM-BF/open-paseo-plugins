import { describe, expect, it } from "vitest";
import { compileSchema, extractJson, SchemaError } from "./json-schema";

describe("compileSchema", () => {
  const schema = {
    type: "object",
    required: ["isReal"],
    properties: { isReal: { type: "boolean" }, reason: { type: "string" } },
  };

  it("validates values and reports paths", () => {
    const compiled = compileSchema(schema);
    expect(compiled.validate({ isReal: true })).toEqual([]);
    expect(compiled.validate({ reason: 1 }).join(" ")).toMatch(/isReal/);
  });

  it.each(["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema"])("supports explicit draft-07 schemas: %s", ($schema) => {
    const compiled = compileSchema({ ...schema, $schema });
    expect(compiled.validate({ isReal: true })).toEqual([]);
    expect(compiled.validate({})).not.toEqual([]);
  });

  it("selects the legacy tuple dialect for array items", () => {
    const compiled = compileSchema({ type: "object", properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false } } });
    expect(compiled.validate({ pair: ["a", 1] })).toEqual([]);
    expect(compiled.validate({ pair: [1, "a"] })).not.toEqual([]);
  });

  it("retains 2020-12 prefixItems validation", () => {
    const compiled = compileSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false } } });
    expect(compiled.validate({ pair: ["a", 1] })).toEqual([]);
    expect(compiled.validate({ pair: [1, "a"] })).not.toEqual([]);
  });

  it("reports unsupported draft-04 with an actionable error", () => {
    expect(() => compileSchema({ ...schema, $schema: "http://json-schema.org/draft-04/schema#" })).toThrow(/Unsupported JSON Schema dialect.*draft-07/);
  });

  it("rejects impossible required properties and bounds before running an agent", () => {
    expect(() => compileSchema({ type: "object", properties: { x: false }, required: ["x"] })).toThrow(/false schema/);
    expect(() => compileSchema({ type: "object", properties: { x: { type: "number", minimum: 5, maximum: 2 } }, required: ["x"] })).toThrow(/numeric bounds/);
    expect(() => compileSchema({ type: "object", properties: {}, minProperties: 3, maxProperties: 1 })).toThrow(/minProperties/);
    expect(() => compileSchema({ type: "object", properties: { forbidden: { type: "string", minLength: 5, maxLength: 2 } } })).not.toThrow();
  });

  it.each([
    [{ type: "array" }],
    ["nope"],
  ])("rejects an unsatisfiable root %j", (bad) => {
    expect(() => compileSchema(bad)).toThrow(SchemaError);
  });
  it("accepts object roots the built-in accepts: no properties, or required naming undeclared keys", () => {
    expect(() => compileSchema({ type: "object" })).not.toThrow();
    expect(compileSchema({ type: "object", properties: {}, required: ["x"] }).validate({ x: 1 })).toEqual([]);
  });
});

describe("extractJson", () => {
  it("parses plain, fenced and embedded JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Result follows {"a":{"b":"}"}} done')).toEqual({ a: { b: "}" } });
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson(null)).toBeUndefined();
  });
});
