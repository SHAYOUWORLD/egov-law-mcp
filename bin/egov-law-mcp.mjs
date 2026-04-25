#!/usr/bin/env node

const SERVER_NAME = "egov-law-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const EGOV_BASE_URL = "https://laws.e-gov.go.jp";
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.EGOV_LAW_MCP_TIMEOUT_MS ?? "15000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
})();

let lawListCache = null;
let lawListFetchedAt = null;

const tools = [
  {
    name: "search_laws",
    description: "Search current Japanese laws from e-Gov Law Search by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Keyword to search in law name, law number, or law ID.",
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
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "get_article",
    description: "Retrieve a specific article from e-Gov Law Search by law ID or law number.",
    inputSchema: {
      type: "object",
      properties: {
        lawId: {
          type: "string",
          description: "e-Gov law ID, for example 503AC0000000035.",
        },
        lawNum: {
          type: "string",
          description: "Japanese law number. Either lawId or lawNum is required.",
        },
        article: {
          type: "string",
          description: "Article number, for example 2.",
        },
        paragraph: {
          type: "string",
          description: "Optional paragraph number.",
        },
      },
      required: ["article"],
      additionalProperties: false,
    },
  },
  {
    name: "get_law",
    description: "Retrieve law metadata and a plain text preview from e-Gov Law Search.",
    inputSchema: {
      type: "object",
      properties: {
        lawId: {
          type: "string",
          description: "e-Gov law ID. Either lawId or lawNum is required.",
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
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_related_laws",
    description: "Find laws related to a base law name, including enforcement orders and regulations.",
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

function categoryToApiValue(category) {
  switch (category) {
    case "acts":
      return "2";
    case "orders":
      return "3";
    case "rules":
      return "4";
    case "all":
    case undefined:
    case null:
      return "1";
    default:
      throw new Error("category must be one of all, acts, orders, rules");
  }
}

async function fetchText(path) {
  if (!path.startsWith("/api/1/") || path.includes("..") || path.includes("//")) {
    throw new Error("Internal error: refused non-e-Gov API path");
  }

  const url = new URL(path, EGOV_BASE_URL);
  if (url.origin !== EGOV_BASE_URL) {
    throw new Error("Internal error: resolved URL escaped e-Gov origin");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": `${SERVER_NAME}/${SERVER_VERSION} (https://codeagent.jp/)`,
        Accept: "application/xml,text/xml,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`e-Gov API returned HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
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

function sourceInfo(path, lawId) {
  const lawUrl = lawId ? `${EGOV_BASE_URL}/law/${encodeURIComponent(lawId)}` : `${EGOV_BASE_URL}${path}`;
  return {
    name: "e-Gov法令検索",
    url: lawUrl,
    apiUrl: `${EGOV_BASE_URL}${path}`,
    attribution: "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
    retrievedAt: new Date().toISOString(),
  };
}

function parseLawList(xml) {
  const results = [];
  const pattern = /<LawNameListInfo>([\s\S]*?)<\/LawNameListInfo>/gi;
  for (const match of xml.matchAll(pattern)) {
    const block = match[1];
    results.push({
      lawId: tagText(block, "LawId"),
      lawName: tagText(block, "LawName"),
      lawNo: tagText(block, "LawNo"),
      promulgationDate: tagText(block, "PromulgationDate"),
    });
  }
  return results.filter((law) => law.lawId && law.lawName);
}

async function getLawList(category = "all") {
  const apiCategory = categoryToApiValue(category);
  if (lawListCache?.[apiCategory]) {
    return lawListCache[apiCategory];
  }

  const xml = await fetchText(`/api/1/lawlists/${apiCategory}`);
  const laws = parseLawList(xml);
  lawListCache = { ...(lawListCache ?? {}), [apiCategory]: laws };
  lawListFetchedAt = new Date().toISOString();
  return laws;
}

function scoreLaw(law, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  const name = law.lawName.toLowerCase();
  const no = law.lawNo.toLowerCase();
  const id = law.lawId.toLowerCase();

  if (name === normalizedKeyword || no === normalizedKeyword || id === normalizedKeyword) return 100;
  if (name.startsWith(normalizedKeyword)) return 90;
  if (name.includes(normalizedKeyword)) return 80;
  if (no.includes(normalizedKeyword) || id.includes(normalizedKeyword)) return 70;

  const tokens = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => name.includes(token) || no.includes(token))) {
    return 60;
  }

  return 0;
}

function lawDocumentUrl(lawId) {
  return `${EGOV_BASE_URL}/law/${encodeURIComponent(lawId)}`;
}

async function searchLaws(args) {
  const keyword = assertString(args?.keyword, "keyword");
  const limit = clampNumber(args?.limit, 10, 1, 50);
  const category = args?.category ?? "all";
  const laws = await getLawList(category);

  const results = laws
    .map((law) => ({ ...law, score: scoreLaw(law, keyword) }))
    .filter((law) => law.score > 0)
    .sort((a, b) => b.score - a.score || a.lawName.localeCompare(b.lawName, "ja"))
    .slice(0, limit)
    .map((law) => ({
      ...law,
      url: lawDocumentUrl(law.lawId),
      source: {
        name: "e-Gov法令検索",
        attribution: "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
      },
    }));

  return {
    keyword,
    category,
    count: results.length,
    cacheFetchedAt: lawListFetchedAt,
    results,
  };
}

function lawIdentifierPath(args) {
  const lawId = typeof args?.lawId === "string" ? args.lawId.trim() : "";
  const lawNum = typeof args?.lawNum === "string" ? args.lawNum.trim() : "";
  if (lawId) return { key: "lawId", value: lawId };
  if (lawNum) return { key: "lawNum", value: lawNum };
  throw new Error("Either lawId or lawNum is required");
}

async function getArticle(args) {
  const identifier = lawIdentifierPath(args);
  const article = assertString(args?.article, "article");
  const params = [`${identifier.key}=${encodeURIComponent(identifier.value)}`, `article=${encodeURIComponent(article)}`];

  if (args?.paragraph !== undefined && args?.paragraph !== null && String(args.paragraph).trim() !== "") {
    params.push(`paragraph=${encodeURIComponent(String(args.paragraph).trim())}`);
  }

  const path = `/api/1/articles;${params.join(";")}`;
  const xml = await fetchText(path);
  const lawId = tagText(xml, "LawId") || (identifier.key === "lawId" ? identifier.value : "");
  const lawNum = tagText(xml, "LawNum") || (identifier.key === "lawNum" ? identifier.value : "");
  const returnedArticle = article;
  const paragraph = args?.paragraph ? String(args.paragraph).trim() : "";
  const articleXml = [...xml.matchAll(/<Article\b[^>]*>[\s\S]*?<\/Article>/gi)]
    .map((match) => match[0])
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const text = stripTags(articleXml || tagText(xml, "ApplData"));

  return {
    lawId,
    lawNum,
    article: returnedArticle,
    paragraph,
    text,
    source: sourceInfo(path, lawId),
    note: "This tool returns source text for reference only and does not provide legal advice.",
  };
}

async function getLaw(args) {
  const identifier = lawIdentifierPath(args);
  const previewChars = clampNumber(args?.previewChars, 5000, 500, 20000);
  const path = `/api/1/lawdata/${encodeURIComponent(identifier.value)}`;
  const xml = await fetchText(path);
  const lawId = tagText(xml, "LawId") || (identifier.key === "lawId" ? identifier.value : "");
  const lawNum = tagText(xml, "LawNum") || (identifier.key === "lawNum" ? identifier.value : "");
  const lawFullTextXml = /<LawFullText(?:\s[^>]*)?>[\s\S]*?<\/LawFullText>/i.exec(xml)?.[0] ?? "";
  const plainText = stripTags(lawFullTextXml);

  return {
    lawId,
    lawNum,
    preview: plainText.slice(0, previewChars),
    previewChars,
    truncated: plainText.length > previewChars,
    source: sourceInfo(path, lawId),
    note: "Use get_article for article-level retrieval and official e-Gov URLs for final verification.",
  };
}

async function findRelatedLaws(args) {
  const lawName = assertString(args?.lawName, "lawName");
  const limit = clampNumber(args?.limit, 10, 1, 50);
  const laws = await getLawList("all");
  const candidates = [
    lawName,
    lawName.endsWith("法律") || lawName.endsWith("法") ? `${lawName}施行令` : null,
    lawName.endsWith("法律") || lawName.endsWith("法") ? `${lawName}施行規則` : null,
    lawName.replace(/法律$/, "法"),
    lawName.replace(/法$/, "法律"),
  ].filter(Boolean);

  const results = laws
    .map((law) => {
      const exact = candidates.some((candidate) => law.lawName === candidate);
      const partial = candidates.some((candidate) => law.lawName.includes(candidate) || candidate.includes(law.lawName));
      const enforcement = law.lawName.includes(lawName.replace(/法律$/, "").replace(/法$/, "")) &&
        (law.lawName.includes("施行令") || law.lawName.includes("施行規則"));
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
      source: {
        name: "e-Gov法令検索",
        attribution: "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
      },
    }));

  return {
    lawName,
    count: results.length,
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
