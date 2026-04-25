# @codeagentjp/egov-law-mcp

Local stdio MCP server for searching Japanese laws and retrieving article text from [e-Gov Law Search](https://laws.e-gov.go.jp/).

This server does not call an LLM. It only returns source-backed law data and e-Gov URLs so your MCP client (Claude Desktop, Claude Code, Cursor, or any other agent) can cite the original source.

Design choices were informed by reading Digital Agency's open-sourced [Lawsy-Custom-BQ](https://github.com/digital-go-jp/genai-ai-api/tree/main/google-cloud/lawsy-custom-bq) (released 2026-04-24 as part of the Gennai government AI OSS release). See the design notes at [codeagent.jp](https://codeagent.jp/posts/gennai-lawsy-mcp-architecture/).

## Why another e-Gov MCP

There is an existing `egov-law-mcp` on npm by another author. This package differs in three ways:

1. **`find_related_laws`** — looks up enforcement orders (施行令) and regulations (施行規則) for a given base law name. Lawsy-Custom-BQ has the same step server-side; useful because definitions and delegated rules often live outside the parent act.
2. **Source attribution baked into every tool result** — every response includes the law name, law ID, article number, and the canonical e-Gov URL, so the calling LLM cannot drop the citation.
3. **Single-file `.mjs`, no build step** — `bin/egov-law-mcp.mjs` runs directly under Node 20+. Easier to audit, smaller install.

## Status

MVP. The API surface is intentionally small:

- `search_laws` — search current Japanese laws by keyword.
- `get_article` — retrieve a specific article from a law by law ID or law number.
- `get_law` — retrieve basic metadata and a text preview for a law.
- `find_related_laws` — find likely related enforcement orders and regulations.

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

Searches the e-Gov law list.

```json
{
  "keyword": "個人情報",
  "limit": 10
}
```

### `get_article`

Retrieves article text. Provide either `lawId` or `lawNum`.

```json
{
  "lawId": "503AC0000000035",
  "article": "2"
}
```

### `get_law`

Retrieves basic metadata and a plain text preview of a law.

```json
{
  "lawId": "503AC0000000035",
  "previewChars": 3000
}
```

### `find_related_laws`

Searches for laws whose names look related to a base law name, including enforcement orders and regulations.

```json
{
  "lawName": "個人情報の保護に関する法律",
  "limit": 10
}
```

## Data Source and Attribution

This package uses the e-Gov Law Search API:

- e-Gov Law Search: <https://laws.e-gov.go.jp/>
- Law API documentation: <https://laws.e-gov.go.jp/docs/law-data-basic/8529371-law-api-v1/>
- e-Gov terms: <https://developer.e-gov.go.jp/contents/terms>
- MCP stdio transport: <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>

Tool results include source attribution. When you publish or redistribute output based on this package, include an appropriate e-Gov source attribution.

Suggested attribution:

> 出典: e-Gov法令検索（<https://laws.e-gov.go.jp/>）

## Safety Notes

- This package is a **law reference tool, not legal advice**. Verify important legal conclusions against the official e-Gov page and, where necessary, consult a qualified professional.
- It does not execute shell commands.
- It writes JSON-RPC messages only to stdout and logs only to stderr.
- It fetches only e-Gov Law Search endpoints.

## Related

- Design notes: [源内のLawsy実装をMCP化するなら、どこを残してどこを捨てるべきか (codeagent.jp)](https://codeagent.jp/posts/gennai-lawsy-mcp-architecture/)
- Background on Gennai OSS release: [政府AI「源内」のソースコードが商用利用可能な形で公開 (codeagent.jp)](https://codeagent.jp/posts/government-ai-gennai-oss-release-2026-04-24/)
- Reference implementation we learned from: [digital-go-jp/genai-ai-api/google-cloud/lawsy-custom-bq](https://github.com/digital-go-jp/genai-ai-api/tree/main/google-cloud/lawsy-custom-bq)

## License

[MIT](./LICENSE) © codeagent.jp
