// Inserts workflows/_shared.js after the meta statement of a built-in workflow. Scripts have no
// import, so this is how the built-ins share their helpers. Used by build-reference.mjs and its test.
export function withShared(source, shared) {
  const start = source.indexOf("export const meta = {");
  const end = start === 0 ? source.indexOf("\n}\n", start) : -1;
  if (end < 0) throw new Error("A built-in workflow must start with `export const meta = {` and close it with a line `}`");
  const cut = end + 3;
  return `${source.slice(0, cut)}\n${shared.trimEnd()}\n${source.slice(cut)}`;
}
