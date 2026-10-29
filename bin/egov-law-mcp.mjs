#!/usr/bin/env node

const SERVER_NAME = "egov-law-mcp";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2025-06-18";
const EGOV_BASE_URL = "https://laws.e-gov.go.jp";
const EGOV_API_PREFIX = "/api/2";
const EGOV_API_NAME = "法令API Version 2";
const ATTRIBUTION = "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）";
const PROCESSING_NOTE = "法令API Version 2 の law_data で取得した法令XMLからタグを除き、平文にした。";
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.EGOV_LAW_MCP_TIMEOUT_MS ?? "15000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
})();
// e-Gov requests are sent one at a time, each at least this long after the
// previous one finished. EGOV_LAW_MCP_INTERVAL_MS can lengthen it, not shorten it.
const MIN_REQUEST_INTERVAL_MS = 1000;
const REQUEST_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.EGOV_LAW_MCP_INTERVAL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > MIN_REQUEST_INTERVAL_MS ? parsed : MIN_REQUEST_INTERVAL_MS;
})();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const CACHE_MAX_BODY_CHARS = 2_000_000;
// laws?law_title= is a partial match on the e-Gov side; up to this many hits are ranked locally.
const SEARCH_SCAN_LIMIT = 500;
const ALLOWED_API_PATH = /^\/api\/2\/(?:laws|law_data\/[^/]+)$/;
const LAW_ID_PATTERN = /^\d{3}[A-Z][0-9A-Z]*$/i;
const LAW_NUM_PATTERN = /^(?:明治|大正|昭和|平成|令和)[元〇一二三四五六七八九十百千0-9]+年|第[〇一二三四五六七八九十百千0-9]+号$/;
const ASOF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const responseCache = new Map();
const pendingRequests = new Map();
let requestChain = Promise.resolve();
let lastRequestFinishedAt = 0;

const asofProperty = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description:
    "Optional point in time (YYYY-MM-DD). Uses the latest revision on or before that date; e-Gov accepts 2017-04-01 or later. Omit for the current version.",
};

const tools = [
  {
    name: "search_laws",
    description:
      "Search current Japanese laws from e-Gov Law Search (Law API v2) by law title, abbreviation, law number, or law ID.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Keyword to search in law title, abbreviation, law number, or law ID.",
        },
        category: {
          type: "string",
          enum: ["all", "acts", "orders", "rules"],
          description: "Law category. Defaults to all.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results. Defaults to 10.",
        },
        asof: asofProperty,
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "get_article",
    description: "Retrieve a specific article from e-Gov Law Search (Law API v2) by law ID or law number.",
    inputSchema: {
      type: "object",
      properties: {
        lawId: {
          type: "string",
          description:
            "e-Gov law ID, for example 322AC0000000049. A law revision ID such as 322AC0000000049_20260717_508AC0000000060 pins that exact version (asof is then ignored).",
        },
        lawNum: {
          type: "string",
          description: "Japanese law number. Either lawId or lawNum is required.",
        },
        article: {
          type: "string",
          description: "Article number in the main provision, for example 32, 32_2, 32の2, or 第三十二条の二.",
        },
        paragraph: {
          type: "string",
          description: "Optional paragraph number, for example 2 or 第二項.",
        },
        asof: asofProperty,
      },
      required: ["article"],
      additionalProperties: false,
    },
  },
  {
    name: "get_law",
    description: "Retrieve law metadata and a plain text preview from e-Gov Law Search (Law API v2).",
    inputSchema: {
      type: "object",
      properties: {
        lawId: {
          type: "string",
          description: "e-Gov law ID or law revision ID. Either lawId or lawNum is required.",
        },
        lawNum: {
          type: "string",
          description: "Japanese law number. Either lawId or lawNum is required.",
        },
        previewChars: {
          type: "number",
          minimum: 500,
          maximum: 20000,
          description: "Maximum preview length. Defaults to 5000.",
        },
        asof: asofProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_related_laws",
    description:
      "Find laws related to a base law name or abbreviation, including enforcement orders and regulations.",
    inputSchema: {
      type: "object",
      properties: {
        lawName: {
          type: "string",
          description: "Base law name, for example 個人情報の保護に関する法律.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results. Defaults to 10.",
        },
        asof: asofProperty,
      },
      required: ["lawName"],
      additionalProperties: false,
    },
  },
];

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function rpcResult(id, result) {
  writeJson({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  writeJson({ jsonrpc: "2.0", id, error });
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function optionalAsof(value) {
  if (value === undefined || value === null || value === "") return null;
  const asof = typeof value === "string" ? value.trim() : "";
  const date = new Date(`${asof}T00:00:00Z`);
  if (!ASOF_PATTERN.test(asof) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== asof) {
    throw new Error("asof must be a calendar date in YYYY-MM-DD format");
  }
  return asof;
}

function categoryToLawType(category) {
  switch (category) {
    case "acts":
      return "Constitution,Act";
    case "orders":
      return "CabinetOrder,ImperialOrder";
    case "rules":
      return "MinisterialOrdinance,Rule";
    case "all":
    case undefined:
    case null:
      return null;
    default:
      throw new Error("category must be one of all, acts, orders, rules");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs e-Gov requests one at a time, each starting no sooner than
// REQUEST_INTERVAL_MS after the previous one finished (whether it succeeded or failed).
function withPacing(task) {
  const run = requestChain.then(async () => {
    for (;;) {
      const wait = lastRequestFinishedAt + REQUEST_INTERVAL_MS - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    try {
      return await task();
    } finally {
      lastRequestFinishedAt = Date.now();
    }
  });
  requestChain = run.catch(() => {});
  return run;
}

function apiUrl(path, params = {}) {
  if (path.includes("..") || path.includes("//") || !ALLOWED_API_PATH.test(path)) {
    throw new Error("Internal error: refused non-e-Gov API path");
  }

  const url = new URL(path, EGOV_BASE_URL);
  if (url.origin !== EGOV_BASE_URL || !ALLOWED_API_PATH.test(url.pathname)) {
    throw new Error("Internal error: resolved URL escaped e-Gov Law API v2");
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function cachedResponse(key) {
  const cached = responseCache.get(key);
  if (!cached || Date.now() - cached.cachedAt >= CACHE_TTL_MS) return null;
  return { data: cached.data, retrievedAt: cached.retrievedAt };
}

function rememberResponse(key, data, retrievedAt) {
  responseCache.delete(key);
  responseCache.set(key, { data, retrievedAt, cachedAt: Date.now() });
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function apiErrorMessage(status, body) {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    const parts = [parsed?.code, parsed?.message].filter((part) => typeof part === "string" && part);
    if (parts.length) detail = ` (${parts.join(": ")})`;
  } catch {
    // Non-JSON error body: report the status only.
  }
  return `e-Gov API returned HTTP ${status}${detail}`;
}

async function requestJson(url, key) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": `${SERVER_NAME}/${SERVER_VERSION} (https://codeagent.jp/)`,
        Accept: "application/json",
      },
    });
    const body = await response.text();
    const retrievedAt = new Date().toISOString();

    if (!response.ok) {
      throw new Error(apiErrorMessage(response.status, body));
    }

    const data = JSON.parse(body);
    if (body.length <= CACHE_MAX_BODY_CHARS) {
      rememberResponse(key, data, retrievedAt);
    }
    return { data, retrievedAt };
  } finally {
    clearTimeout(timeout);
  }
}

// Identical requests share the cached answer, or the one already queued or in flight.
async function fetchJson(url) {
  const key = url.toString();
  const cached = cachedResponse(key);
  if (cached) return cached;

  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const request = withPacing(() => requestJson(url, key)).finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, request);
  return request;
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function tagText(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? decodeXml(stripTags(match[1])).trim() : "";
}

function stripTags(xml) {
  return decodeXml(
    String(xml)
      .replace(/<Ruby>([\s\S]*?)<\/Ruby>/gi, "$1")
      .replace(/<Rt>[\s\S]*?<\/Rt>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function lawDocumentUrl(lawId) {
  return `${EGOV_BASE_URL}/law/${encodeURIComponent(lawId)}`;
}

function splitAbbreviations(abbrev) {
  return typeof abbrev === "string"
    ? abbrev
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function lawSummary(item) {
  const info = item?.law_info ?? {};
  const revision = item?.revision_info ?? {};
  return {
    lawId: info.law_id ?? "",
    lawName: revision.law_title ?? "",
    lawNo: info.law_num ?? "",
    promulgationDate: info.promulgation_date ?? "",
    lawType: info.law_type ?? "",
    abbreviations: splitAbbreviations(revision.abbrev),
    lawRevisionId: revision.law_revision_id ?? "",
    amendmentEnforcementDate: revision.amendment_enforcement_date ?? null,
    currentRevisionStatus: revision.current_revision_status ?? "",
  };
}

function listSource(url, retrievedAt, asof) {
  return {
    name: "e-Gov法令検索",
    api: EGOV_API_NAME,
    apiUrl: url.toString(),
    asof,
    attribution: ATTRIBUTION,
    retrievedAt,
  };
}

function lawSource(url, retrievedAt, lawId, revision, asof) {
  return {
    name: "e-Gov法令検索",
    api: EGOV_API_NAME,
    url: lawId ? lawDocumentUrl(lawId) : url.toString(),
    apiUrl: url.toString(),
    lawId,
    lawRevisionId: revision.law_revision_id ?? "",
    amendmentEnforcementDate: revision.amendment_enforcement_date ?? null,
    asof,
    attribution: ATTRIBUTION,
    processing: PROCESSING_NOTE,
    retrievedAt,
  };
}

function resultSource() {
  return {
    name: "e-Gov法令検索",
    attribution: ATTRIBUTION,
  };
}

async function listLaws(filters, asof) {
  const url = apiUrl(`${EGOV_API_PREFIX}/laws`, {
    ...filters,
    asof,
    repeal_status: "None",
    omit_current_revision_info: "true",
    limit: SEARCH_SCAN_LIMIT,
    response_format: "json",
  });
  const { data, retrievedAt } = await fetchJson(url);
  const laws = (Array.isArray(data?.laws) ? data.laws : []).map(lawSummary).filter((law) => law.lawId && law.lawName);
  const totalCount = Number.isFinite(data?.total_count) ? data.total_count : laws.length;
  return { laws, totalCount, source: listSource(url, retrievedAt, asof) };
}

function searchFilter(keyword) {
  if (LAW_ID_PATTERN.test(keyword)) return { law_id: keyword.toUpperCase() };
  if (LAW_NUM_PATTERN.test(keyword)) return { law_num: keyword };
  // e-Gov matches law_title as one substring, so send the longest token and
  // check the remaining tokens locally in scoreLaw.
  const longest = keyword.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), "");
  return { law_title: longest };
}

function scoreLaw(law, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  const name = law.lawName.toLowerCase();
  const no = law.lawNo.toLowerCase();
  const id = law.lawId.toLowerCase();
  const abbreviations = law.abbreviations.map((value) => value.toLowerCase());

  if (name === normalizedKeyword || no === normalizedKeyword || id === normalizedKeyword) return 100;
  if (abbreviations.includes(normalizedKeyword)) return 95;
  if (name.startsWith(normalizedKeyword)) return 90;
  if (name.includes(normalizedKeyword)) return 80;
  if (abbreviations.some((value) => value.includes(normalizedKeyword))) return 75;
  if (no.includes(normalizedKeyword) || id.includes(normalizedKeyword)) return 70;

  const tokens = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (
    tokens.length > 1 &&
    tokens.every(
      (token) => name.includes(token) || no.includes(token) || abbreviations.some((value) => value.includes(token)),
    )
  ) {
    return 60;
  }

  return 0;
}

async function searchLaws(args) {
  const keyword = assertString(args?.keyword, "keyword");
  const limit = clampNumber(args?.limit, 10, 1, 50);
  const category = args?.category ?? "all";
  const lawType = categoryToLawType(category);
  const asof = optionalAsof(args?.asof);
  const { laws, totalCount, source } = await listLaws({ ...searchFilter(keyword), law_type: lawType }, asof);

  const results = laws
    .map((law) => ({ ...law, score: scoreLaw(law, keyword) }))
    .filter((law) => law.score > 0)
    .sort((a, b) => b.score - a.score || a.lawName.localeCompare(b.lawName, "ja"))
    .slice(0, limit)
    .map((law) => ({
      ...law,
      url: lawDocumentUrl(law.lawId),
      source: resultSource(),
    }));

  return {
    keyword,
    category,
    asof,
    count: results.length,
    matchedCount: totalCount,
    truncated: totalCount > laws.length,
    cacheFetchedAt: source.retrievedAt,
    source,
    results,
  };
}

function lawIdentifier(args) {
  const lawId = typeof args?.lawId === "string" ? args.lawId.trim() : "";
  const lawNum = typeof args?.lawNum === "string" ? args.lawNum.trim() : "";
  if (lawId) return { key: "lawId", value: lawId };
  if (lawNum) return { key: "lawNum", value: lawNum };
  throw new Error("Either lawId or lawNum is required");
}

const KANJI_DIGITS = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS = { 十: 10, 百: 100, 千: 1000 };
const NUMBER_CHARS = "0-9〇一二三四五六七八九十百千";

function parseNumber(text) {
  if (/^[0-9]+$/.test(text)) return Number(text);
  let total = 0;
  let digits = null;
  for (const char of text) {
    if (Object.hasOwn(KANJI_DIGITS, char)) {
      digits = (digits ?? 0) * 10 + KANJI_DIGITS[char];
    } else if (Object.hasOwn(KANJI_UNITS, char)) {
      total += (digits ?? 1) * KANJI_UNITS[char];
      digits = null;
    } else {
      return null;
    }
  }
  return total + (digits ?? 0);
}

// 32, 32_2, 32-2, 32の2, 第32条の2, 第三十二条の二 -> "32" / "32_2" (the Num used in elm)
function articleNumber(value) {
  const normalized = String(value).normalize("NFKC").replace(/\s+/g, "");
  const match = new RegExp(`^第?([${NUMBER_CHARS}]+)条?((?:[の_-][${NUMBER_CHARS}]+)*)$`).exec(normalized);
  if (!match) return null;
  const parts = [match[1], ...match[2].split(/[の_-]/).filter(Boolean)].map(parseNumber);
  return parts.every((part) => Number.isInteger(part) && part > 0) ? parts.join("_") : null;
}

function paragraphNumber(value) {
  const normalized = String(value).normalize("NFKC").replace(/\s+/g, "");
  const match = new RegExp(`^第?([${NUMBER_CHARS}]+)項?$`).exec(normalized);
  const parsed = match ? parseNumber(match[1]) : null;
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

async function fetchLawData(identifier, { asof, elm }) {
  const url = apiUrl(`${EGOV_API_PREFIX}/law_data/${encodeURIComponent(identifier.value)}`, {
    elm,
    asof,
    response_format: "json",
    // The JSON form of the law body is a trial format; ask for law XML instead.
    // e-Gov returns it Base64-encoded because it differs from response_format.
    law_full_text_format: "xml",
  });
  const { data, retrievedAt } = await fetchJson(url);
  const xml =
    typeof data?.law_full_text === "string" ? Buffer.from(data.law_full_text, "base64").toString("utf8") : "";
  return { info: data?.law_info ?? {}, revision: data?.revision_info ?? {}, xml, url, retrievedAt };
}

async function getArticle(args) {
  const identifier = lawIdentifier(args);
  const article = assertString(args?.article, "article");
  const articleNum = articleNumber(article);
  if (!articleNum) {
    throw new Error("article must be an article number such as 32, 32_2, 32の2, or 第三十二条の二");
  }

  const paragraph =
    args?.paragraph !== undefined && args?.paragraph !== null && String(args.paragraph).trim() !== ""
      ? String(args.paragraph).trim()
      : "";
  let elm = `MainProvision-Article_${articleNum}`;
  if (paragraph) {
    const paragraphNum = paragraphNumber(paragraph);
    if (!paragraphNum) {
      throw new Error("paragraph must be a paragraph number such as 2 or 第二項");
    }
    elm += `-Paragraph_${paragraphNum}`;
  }

  const asof = optionalAsof(args?.asof);
  const law = await fetchLawData(identifier, { asof, elm });
  const lawId = law.info.law_id || (identifier.key === "lawId" ? identifier.value : "");
  const lawNum = law.info.law_num || (identifier.key === "lawNum" ? identifier.value : "");

  return {
    lawId,
    lawNum,
    lawTitle: law.revision.law_title ?? "",
    lawRevisionId: law.revision.law_revision_id ?? "",
    article,
    paragraph,
    elm,
    articleCaption: tagText(law.xml, "ArticleCaption"),
    articleTitle: tagText(law.xml, "ArticleTitle"),
    asof,
    text: stripTags(law.xml),
    source: lawSource(law.url, law.retrievedAt, lawId, law.revision, asof),
    note: "This tool returns source text for reference only and does not provide legal advice.",
  };
}

async function getLaw(args) {
  const identifier = lawIdentifier(args);
  const previewChars = clampNumber(args?.previewChars, 5000, 500, 20000);
  const asof = optionalAsof(args?.asof);
  const law = await fetchLawData(identifier, { asof });
  const lawId = law.info.law_id || (identifier.key === "lawId" ? identifier.value : "");
  const lawNum = law.info.law_num || (identifier.key === "lawNum" ? identifier.value : "");
  const plainText = stripTags(law.xml);

  return {
    lawId,
    lawNum,
    lawTitle: law.revision.law_title ?? "",
    abbreviations: splitAbbreviations(law.revision.abbrev),
    lawType: law.info.law_type ?? "",
    promulgationDate: law.info.promulgation_date ?? "",
    lawRevisionId: law.revision.law_revision_id ?? "",
    amendmentEnforcementDate: law.revision.amendment_enforcement_date ?? null,
    currentRevisionStatus: law.revision.current_revision_status ?? "",
    asof,
    preview: plainText.slice(0, previewChars),
    previewChars,
    truncated: plainText.length > previewChars,
    source: lawSource(law.url, law.retrievedAt, lawId, law.revision, asof),
    note: "Use get_article for article-level retrieval and official e-Gov URLs for final verification.",
  };
}

function lawNameStem(lawName) {
  return lawName.replace(/法律$/, "").replace(/法$/, "");
}

// One laws?law_title= query that covers the base law, its 施行令 / 施行規則, and
// the parent law when lawName itself is an enforcement order or regulation.
function relatedLawsQuery(lawName) {
  const stem = lawNameStem(lawName.replace(/(?:施行令|施行規則)$/, ""));
  return stem.length >= 2 ? stem : lawName;
}

async function findRelatedLaws(args) {
  const lawName = assertString(args?.lawName, "lawName");
  const limit = clampNumber(args?.limit, 10, 1, 50);
  const asof = optionalAsof(args?.asof);
  const { laws, totalCount, source } = await listLaws({ law_title: relatedLawsQuery(lawName) }, asof);
  const stem = lawNameStem(lawName);
  const candidates = [
    lawName,
    lawName.endsWith("法律") || lawName.endsWith("法") ? `${lawName}施行令` : null,
    lawName.endsWith("法律") || lawName.endsWith("法") ? `${lawName}施行規則` : null,
    lawName.replace(/法律$/, "法"),
    lawName.replace(/法$/, "法律"),
  ].filter(Boolean);

  const results = laws
    .map((law) => {
      const names = [law.lawName, ...law.abbreviations];
      const exact = names.some((name) => candidates.includes(name));
      const partial = names.some((name) =>
        candidates.some((candidate) => name.includes(candidate) || candidate.includes(name)),
      );
      const enforcement = names.some(
        (name) => name.includes(stem) && (name.includes("施行令") || name.includes("施行規則")),
      );
      return {
        ...law,
        relationScore: exact ? 100 : partial ? 80 : enforcement ? 60 : 0,
      };
    })
    .filter((law) => law.relationScore > 0)
    .sort((a, b) => b.relationScore - a.relationScore || a.lawName.localeCompare(b.lawName, "ja"))
    .slice(0, limit)
    .map((law) => ({
      ...law,
      url: lawDocumentUrl(law.lawId),
      source: resultSource(),
    }));

  return {
    lawName,
    asof,
    count: results.length,
    matchedCount: totalCount,
    truncated: totalCount > laws.length,
    source,
    results,
  };
}

async function callTool(name, args) {
  switch (name) {
    case "search_laws":
      return searchLaws(args);
    case "get_article":
      return getArticle(args);
    case "get_law":
      return getLaw(args);
    case "find_related_laws":
      return findRelatedLaws(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== "2.0") {
    rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC message");
    return;
  }

  const { id, method, params } = message;

  try {
    switch (method) {
      case "initialize":
        rpcResult(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        });
        break;

      case "notifications/initialized":
        break;

      case "ping":
        rpcResult(id, {});
        break;

      case "tools/list":
        rpcResult(id, { tools });
        break;

      case "tools/call": {
        const toolName = assertString(params?.name, "params.name");
        const data = await callTool(toolName, params?.arguments ?? {});
        rpcResult(id, toolResult(data));
        break;
      }

      default:
        if (id !== undefined) {
          rpcError(id, -32601, `Method not found: ${method}`);
        }
        break;
    }
  } catch (error) {
    log(error?.stack ?? String(error));
    if (id !== undefined) {
      rpcError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    rpcError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
    return;
  }

  if (Array.isArray(message)) {
    for (const item of message) {
      await handleRequest(item);
    }
    return;
  }

  await handleRequest(message);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    void handleLine(line);
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    void handleLine(buffer);
  }
});

process.on("uncaughtException", (error) => {
  log(error?.stack ?? String(error));
});

process.on("unhandledRejection", (error) => {
  log(error?.stack ?? String(error));
});
