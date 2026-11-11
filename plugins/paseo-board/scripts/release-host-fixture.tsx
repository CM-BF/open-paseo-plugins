// Real BoardView entry and ReleasePanel. Only transport and GitHub are adapted.
// Static release and Board copy RPCs run the actual server core on loopback.
import "./board-host-fixture";
const browser = globalThis as any;
const fixture = browser.hostFixture;
const originalRpc = fixture.rpc.bind(fixture);
fixture.publicationCalls = [];
fixture.rpc = async (name: string, input: unknown) => {
  if (name !== "board.copy" && !name.startsWith("board.release.") && !name.startsWith("board.pages.") && !name.startsWith("board.live.")) return originalRpc(name, input);
  // Never retained in the page: a diagnostic dump must not expose the live write token.
  const { token: _token, ...recorded } = input as Record<string, unknown>;
  fixture.publicationCalls.push({ name, input: JSON.parse(JSON.stringify(recorded)) });
  const response = await browser.fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, input, board: fixture.board() }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.value;
};
