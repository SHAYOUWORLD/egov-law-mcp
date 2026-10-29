// Preloaded with `node --import` so the server under test never reaches the
// network. It answers e-Gov Law API v2 `laws` and `law_data` from local
// fixtures, and reports each fetch on stderr as one `[mock-fetch] {json}` line
// with the decoded path, the query, its start and end times, and how many
// requests were in flight when it started.

import { readFileSync } from "node:fs";

const LATENCY_MS = Number.parseInt(process.env.MOCK_FETCH_LATENCY_MS ?? "50", 10);
const LAW_LIST = JSON.parse(readFileSync(new URL("./laws.json", import.meta.url), "utf8"));
let inflight = 0;

// 労働基準法 article XML in the shape law_data returned on 2026-10-29, shortened.
const LABOR_STANDARDS_XML = `<Law Era="Showa" Lang="ja" LawType="Act" Num="049" PromulgateDay="07" PromulgateMonth="04" Year="22"><LawNum>昭和二十二年法律第四十九号</LawNum><LawBody><LawTitle Abbrev="労基法" AbbrevKana="ろ" Kana="ろうどうきじゅんほう">労働基準法</LawTitle><MainProvision>
<Chapter Num="4"><ChapterTitle>第四章　労働時間、休憩、休日及び年次有給休暇</ChapterTitle>
<Article Num="32"><ArticleCaption>（労働時間）</ArticleCaption><ArticleTitle>第三十二条</ArticleTitle>
<Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence Num="1" WritingMode="vertical">使用者は、労働者に、休憩時間を除き一週間について四十時間を超えて、労働させてはならない。</Sentence></ParagraphSentence></Paragraph>
<Paragraph Num="2" OldNum="true" OldStyle="false"><ParagraphNum/><ParagraphSentence><Sentence Num="1" WritingMode="vertical">使用者は、一週間の各日については、労働者に、休憩時間を除き一日について八時間を超えて、労働させてはならない。</Sentence></ParagraphSentence></Paragraph>
</Article>
<Article Num="32_2"><ArticleTitle>第三十二条の二</ArticleTitle>
<Paragraph Num="2" OldNum="true" OldStyle="false"><ParagraphNum/><ParagraphSentence><Sentence Num="1" WritingMode="vertical">使用者は、厚生労働省令で定めるところにより、前項の協定を行政官庁に届け出なければならない。</Sentence></ParagraphSentence></Paragraph>
</Article>
</Chapter></MainProvision></LawBody></Law>`;

const laborStandards = LAW_LIST.find((law) => law.law_info.law_id === "322AC0000000049");

// A fictitious law with two revisions, for checking that asof and revision IDs reach e-Gov.
const testLawInfo = {
  law_type: "Act",
  law_id: "999AC0000000001",
  law_num: "令和九十九年法律第一号",
  promulgation_date: "2020-04-01",
};
function testLawRevision(id, enforcementDate, status) {
  return {
    law_revision_id: id,
    law_type: "Act",
    law_title: "テスト法",
    abbrev: "テ法,試験法",
    amendment_enforcement_date: enforcementDate,
    repeal_status: "None",
    current_revision_status: status,
  };
}
function testLawXml(version) {
  const filler = "この条文はテスト用の架空の規定である。".repeat(40);
  return `<Law Era="Reiwa" Lang="ja" LawType="Act" Num="001"><LawNum>令和九十九年法律第一号</LawNum><LawBody><LawTitle>テスト法</LawTitle><MainProvision><Article Num="1"><ArticleTitle>第一条</ArticleTitle><Paragraph Num="1"><ParagraphSentence><Sentence>${version}の規定。&amp;記号&lt;を含む。<Ruby>規<Rt>き</Rt></Ruby>定。</Sentence></ParagraphSentence></Paragraph></Article><Article Num="2"><ArticleTitle>第二条</ArticleTitle><Paragraph Num="1"><ParagraphSentence><Sentence>${filler}</Sentence></ParagraphSentence></Paragraph></Article></MainProvision></LawBody></Law>`;
}

const LAW_DATA = [
  {
    law_info: laborStandards.law_info,
    revisions: [{ revision_info: laborStandards.revision_info, xml: LABOR_STANDARDS_XML }],
  },
  {
    law_info: testLawInfo,
    revisions: [
      {
        revision_info: testLawRevision("999AC0000000001_20200401_000000000000000", "2020-04-01", "PreviousEnforced"),
        xml: testLawXml("旧"),
      },
      {
        revision_info: testLawRevision("999AC0000000001_20260401_508AC0000000099", "2026-04-01", "CurrentEnforced"),
        xml: testLawXml("新"),
      },
    ],
  },
];

function jsonResponse(status, data) {
  return { status, contentType: "application/json", text: JSON.stringify(data) };
}

function asofError(asof) {
  return asof && asof < "2017-04-01"
    ? jsonResponse(400, { code: "400044", message: "法令の時点（asof）には2017-04-01以降を指定してください。" })
    : null;
}

function lawsResponse(params) {
  const error = asofError(params.get("asof"));
  if (error) return error;
  const title = params.get("law_title");
  const lawId = params.get("law_id");
  const lawNum = params.get("law_num");
  const lawTypes = params.get("law_type")?.split(",");
  const repealStatus = params.get("repeal_status")?.split(",");
  const matched = LAW_LIST.filter(
    (law) =>
      (!title || law.revision_info.law_title.includes(title) || (law.revision_info.abbrev ?? "").includes(title)) &&
      (!lawId || law.law_info.law_id.includes(lawId)) &&
      (!lawNum || law.law_info.law_num.includes(lawNum)) &&
      (!lawTypes || lawTypes.includes(law.law_info.law_type)) &&
      (!repealStatus || repealStatus.includes(law.revision_info.repeal_status)),
  );
  const limit = Number.parseInt(params.get("limit") ?? "100", 10);
  const laws = matched.slice(0, limit);
  return jsonResponse(200, { total_count: matched.length, count: laws.length, laws });
}

// Resolves elm paths such as MainProvision-Article_32-Paragraph_2 by element name and Num.
function selectElement(xml, elm) {
  let current = xml;
  for (const step of elm.split("-")) {
    const [tag, num] = step.split(/_(.+)/);
    const attr = num === undefined ? "" : `[^>]*\\bNum="${num}"`;
    const match = new RegExp(`<${tag}\\b${attr}[^>]*>[\\s\\S]*?<\\/${tag}>`).exec(current);
    if (!match) return null;
    current = match[0];
  }
  return current;
}

function lawDataResponse(rawId, params) {
  const error = asofError(params.get("asof"));
  if (error) return error;
  const law = LAW_DATA.find(
    (entry) =>
      entry.law_info.law_id === rawId ||
      entry.law_info.law_num === rawId ||
      entry.revisions.some((revision) => revision.revision_info.law_revision_id === rawId),
  );
  if (!law) {
    return jsonResponse(404, { code: "404004", message: "指定のパラメータで取得できる法令本文ファイルは存在しません。" });
  }
  const asof = params.get("asof");
  const revision =
    law.revisions.find((entry) => entry.revision_info.law_revision_id === rawId) ??
    law.revisions.filter((entry) => !asof || entry.revision_info.amendment_enforcement_date <= asof).at(-1);
  const elm = params.get("elm");
  const xml = elm ? selectElement(revision.xml, elm) : revision.xml;
  if (!xml) {
    return jsonResponse(400, { code: "400021", message: "要素（elm）に合致する要素が法令本文に存在しません。" });
  }
  const base64 = params.get("response_format") === "json" && params.get("law_full_text_format") === "xml";
  return jsonResponse(200, {
    attached_files_info: null,
    law_info: law.law_info,
    revision_info: revision.revision_info,
    law_full_text: base64 ? Buffer.from(xml, "utf8").toString("base64") : { tag: "unexpected-format" },
  });
}

function payloadFor(url) {
  if (url.origin !== "https://laws.e-gov.go.jp") {
    return { status: 599, contentType: "text/plain", text: "mock refused non-e-Gov origin" };
  }
  if (url.pathname === "/api/2/laws") return lawsResponse(url.searchParams);
  if (url.pathname.startsWith("/api/2/law_data/")) {
    return lawDataResponse(decodeURIComponent(url.pathname.slice("/api/2/law_data/".length)), url.searchParams);
  }
  return { status: 404, contentType: "text/plain", text: "mock: unknown path" };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  inflight++;
  const entry = {
    origin: url.origin,
    path: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams),
    accept: init.headers?.Accept ?? null,
    redirect: init.redirect ?? null,
    start: Date.now(),
    inflightAtStart: inflight,
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    inflight--;
    entry.end = Date.now();
    process.stderr.write(`[mock-fetch] ${JSON.stringify(entry)}\n`);
  };

  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  const { status, contentType, text } = payloadFor(url);
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
        return;
      }
      controller.close();
      finish();
    },
    cancel() {
      finish();
    },
  });
  return new Response(body, { status, headers: { "content-type": contentType } });
};
