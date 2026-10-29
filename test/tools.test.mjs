import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertV2Only, call, runServer, toolData, toolError } from "./helpers.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fetchFor(fetches, predicate) {
  const found = fetches.filter(predicate);
  assert.equal(found.length, 1, `expected one matching fetch, got ${found.length}`);
  return found[0];
}

describe("e-Gov Law API v2 tools", { concurrency: true }, () => {
  it("keeps the v0.1 tool names, adds asof to each, and reports one version everywhere", async () => {
    const pkg = readJson("../package.json");
    const server = readJson("../server.json");
    const { responses, fetches } = await runServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    assert.equal(fetches.length, 0);
    assert.equal(responses.find((r) => r.id === 1).result.serverInfo.version, pkg.version);
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0].version, pkg.version);

    const tools = responses.find((r) => r.id === 2).result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["search_laws", "get_article", "get_law", "find_related_laws"],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties.asof.type, "string", tool.name);
      assert.equal(tool.inputSchema.required?.includes("asof") ?? false, false, tool.name);
    }
    assert.deepEqual(tools[0].inputSchema.required, ["keyword"]);
    assert.deepEqual(tools[1].inputSchema.required, ["article"]);
    assert.deepEqual(tools[3].inputSchema.required, ["lawName"]);
  });

  it("search_laws queries laws by title, abbreviation, ID, or number and ranks locally", async () => {
    const { code, responses, fetches } = await runServer([
      call(1, "search_laws", { keyword: "個人情報保護法" }),
      call(2, "search_laws", { keyword: "個人情報", category: "rules", asof: "2026-10-29" }),
      call(3, "search_laws", { keyword: "322ac0000000049" }),
      call(4, "search_laws", { keyword: "平成十五年法律第五十七号" }),
      call(5, "search_laws", { keyword: "個人情報 施行令" }),
      call(6, "search_laws", { keyword: "個人情報", category: "acts", limit: 1 }),
    ]);

    assert.equal(code, 0);
    assertV2Only(fetches);
    assert.equal(fetches.length, 6);
    for (const f of fetches) {
      assert.equal(f.path, "/api/2/laws");
      assert.equal(f.query.repeal_status, "None");
      assert.equal(f.query.omit_current_revision_info, "true");
      assert.equal(f.query.limit, "500");
      assert.equal(f.query.response_format, "json");
    }

    // The abbreviation 個人情報保護法 finds the act and its order and rules.
    const byAbbrev = toolData(responses, 1);
    assert.deepEqual(fetchFor(fetches, (f) => f.query.law_title === "個人情報保護法").query.law_type, undefined);
    assert.deepEqual(
      [byAbbrev.results[0].lawId, byAbbrev.results[0].score],
      ["415AC0000000057", 95],
    );
    assert.deepEqual(
      byAbbrev.results
        .slice(1)
        .map((law) => [law.lawId, law.score])
        .sort(),
      [
        ["415CO0000000507", 75],
        ["428M60020000003", 75],
      ],
    );
    const act = byAbbrev.results[0];
    assert.equal(act.lawName, "個人情報の保護に関する法律");
    assert.equal(act.lawNo, "平成十五年法律第五十七号");
    assert.equal(act.promulgationDate, "2003-05-30");
    assert.equal(act.lawType, "Act");
    assert.deepEqual(act.abbreviations, ["個人情報保護法"]);
    assert.equal(act.lawRevisionId, "415AC0000000057_20261001_507AC0000000070");
    assert.equal(act.url, "https://laws.e-gov.go.jp/law/415AC0000000057");
    assert.equal(act.source.attribution, "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）");
    assert.equal(byAbbrev.asof, null);
    assert.equal(byAbbrev.matchedCount, 3);
    assert.equal(byAbbrev.truncated, false);
    assert.match(byAbbrev.source.apiUrl, /^https:\/\/laws\.e-gov\.go\.jp\/api\/2\/laws\?/);
    assert.equal(byAbbrev.source.api, "法令API Version 2");
    assert.match(byAbbrev.source.retrievedAt, ISO_TIME);
    assert.equal(byAbbrev.cacheFetchedAt, byAbbrev.source.retrievedAt);

    const rules = toolData(responses, 2);
    const rulesFetch = fetchFor(fetches, (f) => f.query.law_type === "MinisterialOrdinance,Rule");
    assert.equal(rulesFetch.query.law_title, "個人情報");
    assert.equal(rulesFetch.query.asof, "2026-10-29");
    assert.equal(rules.asof, "2026-10-29");
    assert.equal(rules.source.asof, "2026-10-29");
    assert.deepEqual(rules.results.map((law) => law.lawType).sort(), ["Rule", "Rule"]);

    assert.equal(fetchFor(fetches, (f) => f.query.law_id).query.law_id, "322AC0000000049");
    assert.deepEqual(
      toolData(responses, 3).results.map((law) => [law.lawName, law.score]),
      [["労働基準法", 100]],
    );

    assert.equal(fetchFor(fetches, (f) => f.query.law_num).query.law_num, "平成十五年法律第五十七号");
    assert.deepEqual(
      toolData(responses, 4).results.map((law) => [law.lawId, law.score]),
      [["415AC0000000057", 100]],
    );

    // Only the longest token goes to e-Gov; every token must still match locally.
    assert.equal(fetches.filter((f) => f.query.law_title === "個人情報" && !f.query.law_type).length, 1);
    assert.deepEqual(
      toolData(responses, 5).results.map((law) => [law.lawName, law.score]),
      [["個人情報の保護に関する法律施行令", 60]],
    );

    const acts = toolData(responses, 6);
    assert.equal(fetchFor(fetches, (f) => f.query.law_type === "Constitution,Act").query.law_title, "個人情報");
    assert.equal(acts.count, 1);
    assert.equal(acts.results[0].lawId, "415AC0000000057");
  });

  it("get_article sends elm and asof to law_data and keeps the source details", async () => {
    const { code, responses, fetches } = await runServer([
      call(1, "get_article", { lawId: "322AC0000000049", article: "32", paragraph: "2", asof: "2026-10-29" }),
      call(2, "get_article", { lawNum: "昭和二十二年法律第四十九号", article: "第三十二条の二" }),
      call(3, "get_article", { lawId: "322AC0000000049", article: "第３２条" }),
      call(4, "get_article", { lawId: "322AC0000000049", article: "999" }),
      call(5, "get_article", { lawId: "322AC0000000049", article: "1", asof: "2015-01-01" }),
      call(6, "get_article", { lawId: "322AC0000000049", article: "第三十二条第二項" }),
      call(7, "get_article", { lawId: "322AC0000000049", article: "32", paragraph: "x" }),
      call(8, "get_article", { lawId: "322AC0000000049", article: "32", asof: "2026/10/29" }),
      call(9, "get_article", { lawId: "322AC0000000049", article: "32", asof: "2026-02-30" }),
      call(10, "get_article", { lawId: "..", article: "1" }),
      call(11, "get_article", { article: "1" }),
    ]);

    assert.equal(code, 0);
    assertV2Only(fetches);
    assert.equal(fetches.length, 5);
    for (const f of fetches) {
      assert.equal(f.query.response_format, "json");
      assert.equal(f.query.law_full_text_format, "xml");
    }

    const paragraph = toolData(responses, 1);
    const paragraphFetch = fetchFor(fetches, (f) => f.query.elm === "MainProvision-Article_32-Paragraph_2");
    assert.equal(paragraphFetch.path, "/api/2/law_data/322AC0000000049");
    assert.equal(paragraphFetch.query.asof, "2026-10-29");
    assert.equal(paragraph.lawId, "322AC0000000049");
    assert.equal(paragraph.lawNum, "昭和二十二年法律第四十九号");
    assert.equal(paragraph.lawTitle, "労働基準法");
    assert.equal(paragraph.lawRevisionId, "322AC0000000049_20260717_508AC0000000060");
    assert.equal(paragraph.article, "32");
    assert.equal(paragraph.paragraph, "2");
    assert.equal(paragraph.elm, "MainProvision-Article_32-Paragraph_2");
    assert.equal(paragraph.asof, "2026-10-29");
    assert.equal(
      paragraph.text,
      "使用者は、一週間の各日については、労働者に、休憩時間を除き一日について八時間を超えて、労働させてはならない。",
    );
    assert.equal(paragraph.source.name, "e-Gov法令検索");
    assert.equal(paragraph.source.url, "https://laws.e-gov.go.jp/law/322AC0000000049");
    assert.match(paragraph.source.apiUrl, /^https:\/\/laws\.e-gov\.go\.jp\/api\/2\/law_data\/322AC0000000049\?/);
    assert.match(paragraph.source.apiUrl, /asof=2026-10-29/);
    assert.equal(paragraph.source.lawId, "322AC0000000049");
    assert.equal(paragraph.source.lawRevisionId, "322AC0000000049_20260717_508AC0000000060");
    assert.equal(paragraph.source.amendmentEnforcementDate, "2026-07-17");
    assert.equal(paragraph.source.asof, "2026-10-29");
    assert.equal(paragraph.source.attribution, "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）");
    assert.match(paragraph.source.processing, /タグを除き/);
    assert.match(paragraph.source.retrievedAt, ISO_TIME);

    // Called by law number, the result still carries the law ID (v0.1 left it empty).
    const branch = toolData(responses, 2);
    assert.equal(fetchFor(fetches, (f) => f.query.elm === "MainProvision-Article_32_2").path, "/api/2/law_data/昭和二十二年法律第四十九号");
    assert.equal(branch.lawId, "322AC0000000049");
    assert.equal(branch.articleTitle, "第三十二条の二");
    assert.equal(branch.source.url, "https://laws.e-gov.go.jp/law/322AC0000000049");

    const whole = toolData(responses, 3);
    assert.equal(whole.elm, "MainProvision-Article_32");
    assert.equal(whole.articleCaption, "（労働時間）");
    assert.match(whole.text, /^（労働時間） 第三十二条 使用者は、労働者に、休憩時間を除き一週間について四十時間/);
    assert.match(whole.text, /一日について八時間を超えて、労働させてはならない。$/);

    assert.match(toolError(responses, 4), /^e-Gov API returned HTTP 400 \(400021: /);
    assert.match(toolError(responses, 5), /^e-Gov API returned HTTP 400 \(400044: /);
    assert.match(toolError(responses, 6), /^article must be an article number/);
    assert.match(toolError(responses, 7), /^paragraph must be a paragraph number/);
    assert.match(toolError(responses, 8), /^asof must be a calendar date/);
    assert.match(toolError(responses, 9), /^asof must be a calendar date/);
    assert.match(toolError(responses, 10), /refused non-e-Gov API path/);
    assert.equal(toolError(responses, 11), "Either lawId or lawNum is required");
  });

  it("get_article returns the revision chosen by asof or by a law revision ID", async () => {
    const { responses, fetches } = await runServer([
      call(1, "get_article", { lawId: "999AC0000000001", article: "1", asof: "2021-01-01" }),
      call(2, "get_article", { lawId: "999AC0000000001", article: "一" }),
      call(3, "get_article", { lawId: "999AC0000000001_20200401_000000000000000", article: "1" }),
      call(4, "get_article", { lawId: "322AC9999999999", article: "1" }),
    ]);

    assertV2Only(fetches);
    assert.equal(fetches.length, 4);

    const old = toolData(responses, 1);
    assert.equal(old.lawRevisionId, "999AC0000000001_20200401_000000000000000");
    assert.equal(old.source.lawRevisionId, "999AC0000000001_20200401_000000000000000");
    assert.equal(old.source.asof, "2021-01-01");
    // Ruby readings are dropped and XML entities decoded.
    assert.equal(old.text, "第一条 旧の規定。&記号<を含む。規定。");

    const current = toolData(responses, 2);
    assert.equal(current.lawRevisionId, "999AC0000000001_20260401_508AC0000000099");
    assert.equal(current.asof, null);
    assert.match(current.text, /^第一条 新の規定。/);

    const pinned = toolData(responses, 3);
    assert.equal(
      fetchFor(fetches, (f) => f.path.endsWith("_000000000000000")).path,
      "/api/2/law_data/999AC0000000001_20200401_000000000000000",
    );
    assert.equal(pinned.lawId, "999AC0000000001");
    assert.equal(pinned.lawRevisionId, "999AC0000000001_20200401_000000000000000");
    assert.match(pinned.text, /^第一条 旧の規定。/);

    assert.match(toolError(responses, 4), /^e-Gov API returned HTTP 404 \(404004: /);
  });

  it("get_law previews the whole law from law_data without elm", async () => {
    const { responses, fetches } = await runServer([
      call(1, "get_law", { lawId: "999AC0000000001", previewChars: 500 }),
      call(2, "get_law", { lawNum: "令和九十九年法律第一号", asof: "2021-01-01", previewChars: 20000 }),
    ]);

    assertV2Only(fetches);
    assert.equal(fetches.length, 2);
    for (const f of fetches) {
      assert.equal(f.query.elm, undefined);
      assert.equal(f.query.law_full_text_format, "xml");
    }

    const current = toolData(responses, 1);
    assert.equal(current.lawId, "999AC0000000001");
    assert.equal(current.lawNum, "令和九十九年法律第一号");
    assert.equal(current.lawTitle, "テスト法");
    assert.deepEqual(current.abbreviations, ["テ法", "試験法"]);
    assert.equal(current.promulgationDate, "2020-04-01");
    assert.equal(current.lawRevisionId, "999AC0000000001_20260401_508AC0000000099");
    assert.equal(current.currentRevisionStatus, "CurrentEnforced");
    assert.equal(current.preview.length, 500);
    assert.equal(current.previewChars, 500);
    assert.equal(current.truncated, true);
    assert.equal(current.source.lawRevisionId, current.lawRevisionId);

    const old = toolData(responses, 2);
    assert.equal(fetchFor(fetches, (f) => f.query.asof).path, "/api/2/law_data/令和九十九年法律第一号");
    assert.equal(old.lawId, "999AC0000000001");
    assert.equal(old.lawRevisionId, "999AC0000000001_20200401_000000000000000");
    assert.equal(old.truncated, false);
    assert.match(old.preview, /^令和九十九年法律第一号 テスト法 第一条 旧の規定。/);
  });

  it("find_related_laws finds orders and rules from one laws query, including by abbreviation", async () => {
    const { responses, fetches } = await runServer([
      call(1, "find_related_laws", { lawName: "個人情報の保護に関する法律" }),
      call(2, "find_related_laws", { lawName: "個人情報保護法" }),
      call(3, "find_related_laws", { lawName: "労働基準法施行規則" }),
      call(4, "find_related_laws", { lawName: "労働基準法", asof: "2026-10-29" }),
    ]);

    assertV2Only(fetches);
    assert.deepEqual(fetches.map((f) => f.query.law_title).sort(), ["個人情報の保護に関する", "個人情報保護", "労働基準", "労働基準"].sort());

    const expected = ["415AC0000000057", "415CO0000000507", "428M60020000003"];
    for (const id of [1, 2]) {
      const related = toolData(responses, id);
      assert.deepEqual(related.results.map((law) => law.lawId).sort(), expected, `id ${id}`);
      assert.ok(related.results.every((law) => law.relationScore === 100), `id ${id}`);
    }

    // From a regulation, the parent act is found too.
    assert.deepEqual(
      toolData(responses, 3).results.map((law) => [law.lawName, law.relationScore]),
      [
        ["労働基準法施行規則", 100],
        ["労働基準法", 80],
      ],
    );

    const labor = toolData(responses, 4);
    assert.equal(fetchFor(fetches, (f) => f.query.asof).query.asof, "2026-10-29");
    assert.equal(labor.asof, "2026-10-29");
    assert.deepEqual(
      labor.results.map((law) => [law.lawId, law.relationScore]),
      [
        ["322AC0000000049", 100],
        ["322M40000100023", 100],
        ["406CO0000000005", 80],
      ],
    );
    assert.equal(labor.results[0].url, "https://laws.e-gov.go.jp/law/322AC0000000049");
  });
});
