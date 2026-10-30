import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DataPatchesSchema, EmitInputSchema, PublishInputSchema } from "../shared/contracts";
import { applyDataPatch } from "./data-patch";

const patch = (path: string, value: unknown, expected: { exists: boolean; value?: unknown } = { exists: false }) => ({ path, operation: "set" as const, value, expected });

describe("conditional JSON data patches", () => {
  it("decodes JSON Pointer escapes and distinguishes absent values from null", () => {
    const initial = { "a/b": { "~name": null, "": 3 } };
    const next = applyDataPatch(initial, [patch("/a~1b/~0name", 4, { exists: true, value: null }), { path: "/a~1b/", operation: "remove", expected: { exists: true, value: 3 } }]);
    expect(next).toEqual({ "a/b": { "~name": 4 } });
    expect(initial).toEqual({ "a/b": { "~name": null, "": 3 } });
    expect(() => applyDataPatch(initial, [patch("/a~1b/~0name", 2)])).toThrow("Data changed");
    expect(applyDataPatch(initial, [{ path: "/missing", operation: "remove", expected: { exists: false } }])).toEqual(initial);
  });

  it("checks a complete batch before changing any value and rejects ambiguous overlap", () => {
    const initial = { object: { a: 1, b: 2 } };
    expect(() => applyDataPatch(initial, [patch("/object/a", 3, { exists: true, value: 1 }), patch("/object/b", 4, { exists: true, value: 9 })])).toThrow("Data changed");
    expect(initial).toEqual({ object: { a: 1, b: 2 } });
    for (const paths of [["/new", "/new"], ["/object", "/object/a"], ["/object/a", "/object"]]) {
      expect(() => applyDataPatch({}, paths.map(path => patch(path, {})))).toThrow();
    }
    expect(() => applyDataPatch(initial, [patch("/object", {}, { exists: true, value: initial.object }), patch("/object/a", 2, { exists: true, value: 1 })])).toThrow("overlapping paths");
  });

  it("never creates unknown parent objects or interprets array indexes as stable identities", () => {
    for (const path of ["/unknown/x", "/list/0", "/list/0/x", "/scalar/x"]) {
      expect(() => applyDataPatch({ list: [{ x: 1 }], scalar: 3 }, [patch(path, 2)])).toThrow(/parent|arrays/);
    }
    expect(applyDataPatch({ list: [1, 2] }, [patch("/list", [2, 1], { exists: true, value: [1, 2] })])).toEqual({ list: [2, 1] });
  });

  it("rejects malformed pointers and prototype traversal without pollution", () => {
    for (const path of ["", "plain", "/bad~", "/bad~2", "/__proto__/polluted", "/constructor/prototype/polluted", "/ok/prototype", "/" + "part/".repeat(64)]) {
      expect(() => applyDataPatch({}, [patch(path, true)])).toThrow();
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("requires precise operation and expected-value shapes and valid JSON values", () => {
    const valid = patch("/x", null);
    expect(DataPatchesSchema.parse([valid])).toEqual([valid]);
    for (const invalid of [
      { ...valid, expected: { exists: true } }, { ...valid, expected: { exists: false, value: null } },
      { path: "/x", operation: "set", expected: { exists: false } }, { ...valid, operation: "remove" },
    ]) expect(DataPatchesSchema.safeParse([invalid]).success).toBe(false);
    for (const value of [undefined, NaN, Infinity, () => 3]) expect(() => applyDataPatch({}, [patch("/x", value)])).toThrow("JSON");
    expect(() => applyDataPatch({ x: 1 }, [patch("/x", 2, { exists: true, value: undefined })])).toThrow("JSON");
  });

  it("keeps MCP schema extension and JSON schema generation executable", () => {
    const publish = z.toJSONSchema(PublishInputSchema.extend({ htmlFile: z.string().optional() }), { io: "input" });
    const emit = z.toJSONSchema(EmitInputSchema, { io: "input" });
    expect(publish.properties).toHaveProperty("canvasBase");
    expect(publish.properties).toHaveProperty("replaceDocument");
    expect(emit.properties).toHaveProperty("dataPatch");
  });
});
