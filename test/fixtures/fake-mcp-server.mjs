// Tiny fake stdio MCP server for tests.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (m.method === "tools/call") {
    if (m.params.name === "hang") return;
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo:${m.params.arguments?.text ?? ""}` }] } });
  } else if (m.id != null) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
});
