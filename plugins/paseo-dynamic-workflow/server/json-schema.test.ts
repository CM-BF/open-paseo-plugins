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

  it.each([
    [{ type: "array" }],
    [{ type: "object" }],
    [{ type: "object", properties: {}, required: ["x"] }],
    ["nope"],
  ])("rejects an unsatisfiable root %j", (bad) => {
    expect(() => compileSchema(bad)).toThrow(SchemaError);
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
