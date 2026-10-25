import { describe, expect, it } from "vitest";
import { parseWorkflowScript, ScriptError } from "./script-parse";

describe("parseWorkflowScript", () => {
  it("reads a pure literal meta and keeps line numbers of the body", () => {
    const parsed = parseWorkflowScript(
      "export const meta = {\n  name: 'x',\n  description: `d`,\n  phases: [{ title: 'A', detail: 'a' }, 'B'],\n}\nreturn 1\n",
    );
    expect(parsed.meta).toEqual({ name: "x", description: "d", phases: [{ title: "A", detail: "a" }, { title: "B" }] });
    expect(parsed.body.split("\n")[5]).toBe("return 1");
  });

  it.each([
    ["missing meta", "const x = 1"],
    ["meta not first", "const a = 1\nexport const meta = { name: 'x', description: 'd' }"],
    ["computed value", "const n = 'x'\nexport const meta = { name: n, description: 'd' }"],
    ["interpolation", "export const meta = { name: `a${1}`, description: 'd' }"],
    ["call in meta", "export const meta = { name: String(1), description: 'd' }"],
    ["spread in meta", "export const meta = { ...{}, name: 'x', description: 'd' }"],
    ["no description", "export const meta = { name: 'x' }"],
  ])("rejects %s", (_label, source) => {
    expect(() => parseWorkflowScript(source)).toThrow(ScriptError);
  });

  it.each([["Date.now()"], ["Math.random()"], ["new Date()"], ["Date()"]])("rejects %s", (expression) => {
    expect(() => parseWorkflowScript(`export const meta = { name: 'x', description: 'd' }\nconst t = ${expression}`)).toThrow(/deterministic/);
  });

  it("allows new Date(value)", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nconst t = new Date(0)")).not.toThrow();
  });

  it("rejects imports and extra exports", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nimport fs from 'fs'")).toThrow(/import/);
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nexport const y = 1")).toThrow(/exported/);
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nawait import('fs')")).toThrow(/import/);
  });

  it("explains TypeScript syntax", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nconst a: string[] = []")).toThrow(/looks like TypeScript/);
  });

  it("shows the offending line with a caret and the plain-JavaScript hint for any parse error", () => {
    let message = "";
    try { parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nconst s = 'it's broken'"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("const s = 'it's broken'\n              ^");
    expect(message).toMatch(/plain JavaScript/);
  });

  it("accepts top-level await and return", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nconst r = await agent('x')\nreturn r")).not.toThrow();
  });

  it("rejects module-only syntax and invalid strict bodies before launch", () => {
    const prefix = "export const meta = { name: 'x', description: 'd' }\n";
    expect(() => parseWorkflowScript(prefix + "return import.meta.url")).toThrow(/compile/);
    expect(() => parseWorkflowScript(prefix + "with ({}) {}")).toThrow(/parse|compile/);
  });

  it("allows local declarations to shadow workflow globals", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd' }\nconst log = []; let args = 1; return { log, args }")).not.toThrow();
  });
});

describe("meta leniency", () => {
  it("ignores optional meta fields of the wrong type and keeps title, like the built-in", () => {
    const parsed = parseWorkflowScript("export const meta = { name: 'x', description: 'd', title: 'T', whenToUse: 5, phases: [{ title: 'A' }, { nope: 1 }] }\nreturn 1");
    expect(parsed.meta).toMatchObject({ name: "x", title: "T", phases: [{ title: "A" }] });
    expect(parsed.meta.whenToUse).toBeUndefined();
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'd', phases: 'none' }\nreturn 1")).not.toThrow();
  });
});
