import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertV2Only, call, runServer, toolData, toolError } from "./helpers.mjs";

const MIN_INTERVAL_MS = 1000;

function assertPaced(fetches, intervalMs) {
  for (const f of fetches) {
    assert.equal(f.inflightAtStart, 1, `concurrent e-Gov request at ${f.path}`);
  }
  for (let i = 1; i < fetches.length; i++) {
    const gap = fetches[i].start - fetches[i - 1].end;
    assert.ok(gap >= intervalMs, `request ${i + 1} started ${gap}ms after the previous one finished`);
  }
}

describe("e-Gov request pacing and cache", { concurrency: true }, () => {
  it("sends one request at a time, at least 1s after the previous one finished, and reuses identical responses", async () => {
    const { code, responses, fetches } = await runServer([
      [
        call(1, "search_laws", { keyword: "個人情報" }),
        call(2, "get_article", { lawId: "322AC0000000049", article: "32" }),
      ],
      call(3, "get_article", { lawId: "322AC9999999999", article: "1" }),
      call(4, "find_related_laws", { lawName: "労働基準法" }),
      call(5, "get_article", { lawId: "322AC0000000049", article: "32" }),
      call(6, "search_laws", { keyword: "個人情報" }),
    ]);

    assert.equal(code, 0);
    assertV2Only(fetches);
    // ids 5 and 6 repeat ids 2 and 1 and are served from the cache.
    assert.equal(fetches.length, 4);
    assertPaced(fetches, MIN_INTERVAL_MS);

    assert.match(toolError(responses, 3), /404004/);
    const first = toolData(responses, 2);
    const repeated = toolData(responses, 5);
    assert.equal(repeated.text, first.text);
    // A cached answer keeps the time it was actually retrieved from e-Gov.
    assert.equal(repeated.source.retrievedAt, first.source.retrievedAt);
    assert.equal(toolData(responses, 6).cacheFetchedAt, toolData(responses, 1).cacheFetchedAt);
  });

  it("ignores EGOV_LAW_MCP_INTERVAL_MS below 1s", async () => {
    const { responses, fetches } = await runServer(
      [call(1, "search_laws", { keyword: "個人情報" }), call(2, "search_laws", { keyword: "労働基準法" })],
      { EGOV_LAW_MCP_INTERVAL_MS: "0" },
    );

    toolData(responses, 1);
    toolData(responses, 2);
    assert.equal(fetches.length, 2);
    assertPaced(fetches, MIN_INTERVAL_MS);
  });

  it("honours a longer EGOV_LAW_MCP_INTERVAL_MS", async () => {
    const { responses, fetches } = await runServer(
      [call(1, "search_laws", { keyword: "個人情報" }), call(2, "search_laws", { keyword: "労働基準法" })],
      { EGOV_LAW_MCP_INTERVAL_MS: "1800" },
    );

    toolData(responses, 1);
    toolData(responses, 2);
    assert.equal(fetches.length, 2);
    assertPaced(fetches, 1800);
  });
});
