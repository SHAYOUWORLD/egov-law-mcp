# Law API v2 fixtures

`mock-fetch.mjs` is preloaded with `node --import` so the real stdio server answers from these fixtures and never uses the network. It implements the parts of `GET /api/2/laws` and `GET /api/2/law_data/{id}` the tools rely on: partial `law_title` (title or abbreviation), `law_id`, `law_num`, `law_type`, `repeal_status`, `limit`, `asof` (including the 400044 error before 2017-04-01), `elm` paths (400021 when missing), unknown laws (404004), and the Base64 law XML returned for `response_format=json&law_full_text_format=xml`.

- `laws.json`: eight `law_info` / `revision_info` pairs copied unchanged from `laws` responses retrieved on 2026-10-29 (JST) — `https://laws.e-gov.go.jp/api/2/laws?law_title=個人情報&repeal_status=None&limit=500&response_format=json` and `…?law_title=労働&repeal_status=None&limit=500&response_format=json`. `current_revision_info` was dropped.
- 労働基準法 article XML in `mock-fetch.mjs`: the element structure and sentences of 第三十二条 and 第三十二条の二 as `law_data` returned them on 2026-10-29 (`elm=MainProvision-Article_32-Paragraph_2` and `elm=MainProvision-Article_32_2`), shortened to the parts the tests read. 第三十二条の二 keeps only its second paragraph.
- テスト法 (`999AC0000000001`) is fictitious. Its two revisions exist only to check that `asof` and law revision IDs reach e-Gov and that the returned version is reported.

Source: e-Gov法令検索（https://laws.e-gov.go.jp/）. The fixtures are frozen test inputs, not the current state of any law.
