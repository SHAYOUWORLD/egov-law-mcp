import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/egov-law-mcp.mjs", import.meta.url));
const MOCK_FETCH = new URL("./fixtures/mock-fetch.mjs", import.meta.url).href;

export const EGOV_ORIGIN = "https://laws.e-gov.go.jp";

export function call(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

// Starts the real server with fetch mocked, writes every line at once, closes
// stdin, and waits for the server to finish all queued work and exit.
export function runServer(lines, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  if (!("EGOV_LAW_MCP_INTERVAL_MS" in envOverrides)) delete env.EGOV_LAW_MCP_INTERVAL_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", MOCK_FETCH, BIN], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const responses = stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
        .flat();
      const fetches = stderr
        .split("\n")
        .filter((line) => line.startsWith("[mock-fetch] "))
        .map((line) => JSON.parse(line.slice("[mock-fetch] ".length)))
        .sort((a, b) => a.start - b.start);
      resolve({ code, responses, fetches, stderr });
    });
    child.stdin.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  });
}

export function toolData(responses, id) {
  const response = responses.find((r) => r.id === id);
  assert.ok(response, `no response for id ${id}`);
  assert.equal(response.error, undefined, `id ${id}: ${JSON.stringify(response.error)}`);
  return JSON.parse(response.result.content[0].text);
}

export function toolError(responses, id) {
  const response = responses.find((r) => r.id === id);
  assert.ok(response, `no response for id ${id}`);
  assert.ok(response.error, `id ${id} unexpectedly succeeded`);
  return response.error.message;
}

// Every request must stay on e-Gov Law API v2, ask for JSON, and refuse redirects.
export function assertV2Only(fetches) {
  for (const f of fetches) {
    assert.equal(f.origin, EGOV_ORIGIN);
    assert.match(f.path, /^\/api\/2\/(?:laws|law_data\/[^/]+)$/);
    assert.equal(f.accept, "application/json");
    assert.equal(f.redirect, "error");
  }
}
