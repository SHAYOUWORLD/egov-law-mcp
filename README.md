# @codeagentjp/egov-law-mcp

Local stdio MCP server for searching Japanese laws and retrieving article text from [e-Gov Law Search](https://laws.e-gov.go.jp/) through the e-Gov Law API Version 2.

This server does not call an LLM. It only returns source-backed law data and e-Gov URLs so your MCP client (Claude Desktop, Claude Code, Cursor, or any other agent) can cite the original source.

Design choices were informed by reading Digital Agency's open-sourced [Lawsy-Custom-BQ](https://github.com/digital-go-jp/genai-ai-api/tree/main/google-cloud/lawsy-custom-bq) (released 2026-04-24 as part of the Gennai government AI OSS release). See the design notes at [codeagent.jp](https://codeagent.jp/posts/gennai-lawsy-mcp-architecture/).

## Why another e-Gov MCP

There is an existing `egov-law-mcp` on npm by another author. This package differs in four ways:

1. **`find_related_laws`** — looks up enforcement orders (施行令) and regulations (施行規則) for a given base law name or abbreviation. Lawsy-Custom-BQ has the same step server-side; useful because definitions and delegated rules often live outside the parent act.
2. **Source attribution baked into every tool result** — every response includes the law name, law ID, article number, the law revision ID (版), the retrieval time, and the canonical e-Gov URL, so the calling LLM cannot drop the citation.
3. **Point-in-time retrieval** — every tool accepts `asof` (YYYY-MM-DD), so you can pin the same version of a law that a benchmark or an earlier answer used.
4. **Single-file `.mjs`, no build step** — `bin/egov-law-mcp.mjs` runs directly under Node 20+. Easier to audit, smaller install.

## Status

MVP. The API surface is intentionally small:

- `search_laws` — search current Japanese laws by title, abbreviation, law number, or law ID.
- `get_article` — retrieve a specific article (or paragraph) from a law by law ID, law number, or law revision ID.
- `get_law` — retrieve basic metadata and a text preview for a law.
- `find_related_laws` — find likely related enforcement orders and regulations.

All four accept an optional `asof`. Since v0.2.0 every request goes to Law API v2 (`/api/2/laws` and `/api/2/law_data/{id}`); nothing calls the v1 endpoints any more. See [Compatibility with v0.1.x](#compatibility-with-v01x).

## Requirements

- Node.js 20 or later
- Network access to `https://laws.e-gov.go.jp`

## Install

From npm:

```json
{
  "mcpServers": {
    "egov-law": {
      "command": "npx",
      "args": ["-y", "@codeagentjp/egov-law-mcp"]
    }
  }
}
```

From source for development:

```bash
git clone https://github.com/SHAYOUWORLD/egov-law-mcp.git
cd egov-law-mcp
node bin/egov-law-mcp.mjs
```

```json
{
  "mcpServers": {
    "egov-law": {
      "command": "node",
      "args": ["/absolute/path/to/egov-law-mcp/bin/egov-law-mcp.mjs"]
    }
  }
}
```

## Tools

### `search_laws`

Searches laws that are not repealed (`repeal_status=None`) with one `laws` request. Keywords that look like a law ID (`322AC0000000049`) go to `law_id`, keywords that look like a law number (`平成十五年法律第五十七号`, `…第五十七号`) go to `law_num`, and everything else goes to `law_title`, which e-Gov matches against both the title and its abbreviations (`個人情報保護法` finds 個人情報の保護に関する法律). With several space-separated words, the longest goes to e-Gov and the rest are checked locally. Up to 500 matches are ranked locally; `truncated: true` means e-Gov had more and the keyword should be narrowed.

```json
{
  "keyword": "個人情報保護法",
  "category": "all",
  "limit": 10,
  "asof": "2026-10-29"
}
```

`category` maps to `law_type`: `acts` = Constitution, Act; `orders` = CabinetOrder, ImperialOrder; `rules` = MinisterialOrdinance, Rule; `all` = no filter.

### `get_article`

Retrieves an article from the main provision (本則) with `law_data?elm=MainProvision-Article_N[-Paragraph_M]`. Provide either `lawId` or `lawNum`. `article` accepts `32`, `32_2`, `32の2`, `第32条の2`, or `第三十二条の二`; `paragraph` accepts `2` or `第二項`.

```json
{
  "lawId": "322AC0000000049",
  "article": "32",
  "paragraph": "2",
  "asof": "2026-10-29"
}
```

To pin an exact version, pass a law revision ID as `lawId` (for example `322AC0000000049_20260717_508AC0000000060`); e-Gov then ignores `asof`. e-Gov accepts `asof` from 2017-04-01 onward.

### `get_law`

Retrieves basic metadata and a plain text preview of a law.

```json
{
  "lawId": "503AC0000000035",
  "previewChars": 3000
}
```

### `find_related_laws`

Searches for laws whose names or abbreviations look related to a base law name, including enforcement orders and regulations. It sends one `laws?law_title=` request with the name minus a trailing 法律 / 法 (and minus 施行令 / 施行規則, so a regulation also finds its parent act).

```json
{
  "lawName": "個人情報の保護に関する法律",
  "limit": 10
}
```

### What the results contain

`get_article` and `get_law` return `lawId`, `lawNum`, `lawTitle`, `lawRevisionId`, and `asof`, plus a `source` object:

```json
{
  "name": "e-Gov法令検索",
  "api": "法令API Version 2",
  "url": "https://laws.e-gov.go.jp/law/322AC0000000049",
  "apiUrl": "https://laws.e-gov.go.jp/api/2/law_data/322AC0000000049?elm=MainProvision-Article_32-Paragraph_2&asof=2026-10-29&response_format=json&law_full_text_format=xml",
  "lawId": "322AC0000000049",
  "lawRevisionId": "322AC0000000049_20260717_508AC0000000060",
  "amendmentEnforcementDate": "2026-07-17",
  "asof": "2026-10-29",
  "attribution": "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
  "processing": "法令API Version 2 の law_data で取得した法令XMLからタグを除き、平文にした。",
  "retrievedAt": "2026-10-29T05:57:09.260Z"
}
```

`url` opens the current version on e-Gov Law Search. `apiUrl` reproduces the exact request, and `lawRevisionId` identifies the version that was returned. `search_laws` and `find_related_laws` return `source` with `apiUrl`, `asof`, and `retrievedAt` at the top level, and each result carries `lawRevisionId`, `abbreviations`, and the e-Gov URL.

## Compatibility with v0.1.x

v0.1.x called Law API v1 (`/api/1/lawlists`, `/api/1/lawdata`, `/api/1/articles`), which has no point-in-time parameter. v0.2.0 moves every tool to v2. The decision record is [docs/adr/0001-law-api-v2-migration.md](./docs/adr/0001-law-api-v2-migration.md).

Unchanged:

- Tool names, required inputs (`keyword`, `article`, `lawName`, and `lawId` or `lawNum`), and every existing input name.
- Every existing output field name (`lawId`, `lawName`, `lawNo`, `promulgationDate`, `score`, `relationScore`, `url`, `text`, `preview`, `truncated`, `source.url`, `source.apiUrl`, `source.attribution`, `source.retrievedAt`, …).

Added:

- `asof` input on all four tools.
- Output fields such as `lawTitle`, `lawRevisionId`, `abbreviations`, `lawType`, `articleTitle`, `articleCaption`, `elm`, `matchedCount`, and `source.lawRevisionId` / `source.asof` / `source.processing`.

Changed:

- `promulgationDate` is now `YYYY-MM-DD` (v2 format) instead of `yyyyMMdd`.
- `search_laws` no longer downloads the whole law list once per process. Each search is one `laws` request filtered by e-Gov, so abbreviations now match and results can differ from v0.1.x. `cacheFetchedAt` is kept and now holds the time that request's data was retrieved.
- `find_related_laws` only finds laws that share the base name's stem; v0.1.x could also list unrelated laws whose short names happened to appear inside the base name.
- `get_article` called with `lawNum` now also returns `lawId` (v1 left it empty). `paragraph` is checked as a number, and article numbers are converted for `elm`.
- Errors from e-Gov include its code, for example `e-Gov API returned HTTP 400 (400021: 要素（elm）に合致する要素が法令本文に存在しません。)`.
- Requests to e-Gov are paced (see below).

## Request pacing and cache

- At most one request goes to `laws.e-gov.go.jp` at a time, even when a client calls several tools at once or sends a JSON-RPC batch.
- Each request starts at least 1 second after the previous one finished. Set `EGOV_LAW_MCP_INTERVAL_MS` to wait longer; values below `1000` are ignored.
- Identical requests within 5 minutes are answered from an in-process cache (or share the request already in flight) and do not reach e-Gov. Cached answers keep their original `retrievedAt`.
- `EGOV_LAW_MCP_TIMEOUT_MS` (default `15000`) sets the per-request timeout. It starts when the request is sent, not while it waits for its turn.

The pacing applies within one server process; if you run several copies, keep their combined traffic modest.

## Data Source and Attribution

This package uses the e-Gov Law API Version 2:

- e-Gov Law Search: <https://laws.e-gov.go.jp/>
- Law API Version 2 (Swagger UI): <https://laws.e-gov.go.jp/api/2/swagger-ui>
- Law API Version 2 OpenAPI definition (version 2.1.139 when checked on 2026-10-29): <https://laws.e-gov.go.jp/api/2/swagger-ui/lawapi-v2.yaml>
- e-Gov terms: <https://laws.e-gov.go.jp/terms/>
- MCP stdio transport: <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>

The law body is requested as law XML (`law_full_text_format=xml`, Base64 inside the JSON response) because the OpenAPI definition marks the JSON form of the body as a trial format that may change.

Tool results include source attribution. When you publish or redistribute output based on this package, include an appropriate e-Gov source attribution, and say that the text was converted from law XML to plain text (`source.processing`).

Suggested attribution:

> 出典: e-Gov法令検索（<https://laws.e-gov.go.jp/>）

## Safety Notes

- This package is a **law reference tool, not legal advice**. Verify important legal conclusions against the official e-Gov page and, where necessary, consult a qualified professional.
- It does not execute shell commands.
- It writes JSON-RPC messages only to stdout and logs only to stderr.
- It fetches only `https://laws.e-gov.go.jp/api/2/laws` and `https://laws.e-gov.go.jp/api/2/law_data/{id}`, and refuses redirects.

## Development checks

```bash
npm test
```

Tests launch the stdio server with `fetch` replaced by local Law API v2 fixtures. They cover each tool's request parameters and output fields, `asof` and law revision IDs, input validation, e-Gov error codes, request pacing, and the cache. Fixture sources are in `test/fixtures/README.md`.

## Related

- Design notes: [源内OSSのLawsy実装をMCP化するなら、どこを残してどこを捨てるか (codeagent.jp)](https://codeagent.jp/posts/gennai-lawsy-mcp-architecture/)
- Background on Gennai OSS release: [源内OSS公開の背景 (codeagent.jp)](https://codeagent.jp/posts/gennai-lawsy-mcp-architecture/#源内oss公開の背景)
- Setup guides (Japanese): [Claude Code](https://codeagent.jp/posts/egov-law-mcp-claude-code-demo/) / [Codex CLI](https://codeagent.jp/posts/egov-law-mcp-codex-cli-setup/) / [Troubleshooting](https://codeagent.jp/posts/egov-law-mcp-troubleshooting/)
- e-Gov Law API v2 guide (Japanese): [codeagent.jp/guides/egov-law-api/](https://codeagent.jp/guides/egov-law-api/)
- Law API v1 → v2 migration guide (Japanese): [codeagent.jp/posts/egov-law-api-v1-to-v2-migration/](https://codeagent.jp/posts/egov-law-api-v1-to-v2-migration/)
- Other Japanese public-data APIs and MCP servers: [codeagent.jp/guides/public-data-api/](https://codeagent.jp/guides/public-data-api/)
- Reference implementation we learned from: [digital-go-jp/genai-ai-api/google-cloud/lawsy-custom-bq](https://github.com/digital-go-jp/genai-ai-api/tree/main/google-cloud/lawsy-custom-bq)

## License

[MIT](./LICENSE) © codeagent.jp
