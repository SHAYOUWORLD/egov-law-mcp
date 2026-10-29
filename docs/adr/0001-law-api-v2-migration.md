# ADR 0001 — e-Gov法令API v1 から v2 へ移り、時点指定（asof）を受け付ける

- Status: Accepted
- Date: 2026-10-29
- Related: houan-mcp ADR 0004（NDL への問い合わせ間隔）

## Context

v0.1.1 までの4ツールは、e-Gov法令API Version 1 だけを呼んでいた。

| ツール | v0.1.1 が呼んでいたもの |
| --- | --- |
| `search_laws` | `/api/1/lawlists/{1〜4}`。全件の一覧XMLをプロセスで1回取り、手元で部分一致 |
| `get_article` | `/api/1/articles;lawId=…;article=…;paragraph=…` |
| `get_law` | `/api/1/lawdata/{法令ID又は法令番号}` |
| `find_related_laws` | `/api/1/lawlists/1` を手元で照合 |

v1 には時点指定がない。CodeAgent の法令ベンチ（SHAYOUWORLD/codeagent PR #160）は正解を v2 `law_data` の `asof=2026-10-29` で作っており、同じ版の条文をこの MCP から渡せなかった。ベンチは v2 を直接呼んで代用した。CodeAgent は「公共データAPI × AI」を柱にしており、自作の MCP が旧版の API に依存したままでは記事の主張と合わない。

2026-10-29 に e-Gov法令検索の公式資料で確かめたこと：

- [お知らせ一覧](https://laws.e-gov.go.jp/news/) の掲載は2件（2024-07-29 のリニューアル、2025-03-19 の法令API Version 2 リリース）だけで、v1 の提供終了・非推奨化の告知はない。移行は急ぎではない。
- [OpenAPI 定義](https://laws.e-gov.go.jp/api/2/swagger-ui/lawapi-v2.yaml) は version 2.1.139。
  - `laws`：`law_title` は法令名又は法令略称の部分一致。`law_id`・`law_num` も部分一致。`law_type` は複数指定可。`asof`、`repeal_status`、`limit`（既定100）、`offset`、`omit_current_revision_info` がある。応答に `total_count`。
  - `law_data/{law_id_or_num_or_revision_id}`：`elm`（要素パス）、`asof`（法令履歴IDを指定した場合は無視）、`response_format`、`law_full_text_format`。両者が食い違うと `law_full_text` は Base64 で返る。
  - 「法令本文取得APIで返却されるJSON形式のデータ」は試行版で、仕様変更がありうると注記されている。
  - 問い合わせの頻度や間隔の定めは見当たらない。
- 法令API Version1 の案内ページ（`/apitop/`）と利用規約（`/terms/`）は JavaScript で描画されるページで、今回は本文を読んでいない。利用規約が公共データ利用規約（PDL1.0）を適用し、出典と、編集・加工した旨の記載を求めている点は、CodeAgent の[移行記事](https://codeagent.jp/posts/egov-law-api-v1-to-v2-migration/)（2026-09-14 確認）に拠る。

同日の実測（直列、前の完了から1.2秒以上あけて14件）：

- `laws?law_title=労働&repeal_status=None&limit=500` は227件を1回で返した（541,361バイト）。`limit` が100を超えても受け付けられる。
- `law_title=個人情報保護法` は略称の一致で、法律・施行令・施行規則の3件を返した。
- `elm=MainProvision-Article_32-Paragraph_2` は労働基準法第32条第2項の `Paragraph` 要素だけを返した。`Article_32_2` は第三十二条の二。法令番号で呼んでも `law_info.law_id` が入る。
- 存在しない要素は 400（`400021`）、存在しない法令IDは 404（`404004`）、`asof=2015-01-01` は 400（`400044`、2017-04-01 以降を指定）。

## Decision

### 1. 4ツールとも v2 を呼ぶ

| ツール | v0.2.0 が呼ぶもの |
| --- | --- |
| `search_laws` | `laws?law_title=…`（法令IDらしい語は `law_id`、法令番号らしい語は `law_num`）`&repeal_status=None&omit_current_revision_info=true&limit=500` を検索ごとに1回。手元で順位付け |
| `get_article` | `law_data/{id}?elm=MainProvision-Article_N[-Paragraph_M]` |
| `get_law` | `law_data/{id}` |
| `find_related_laws` | `laws?law_title={法令名から末尾の法律・法と施行令・施行規則を除いた語}` を1回。手元で照合 |

条番号は `32`・`32_2`・`32の2`・`第三十二条の二` などを受け、漢数字と全角数字を `elm` の `Num`（`32_2`）に直す。項も `2`・`第二項` を受ける。本則（`MainProvision`）だけを対象にするのは v0.1 と同じ。

### 2. 時点指定

4ツールに任意の `asof`（YYYY-MM-DD）を足す。手元では形式と暦日だけを確かめ、2017-04-01 より前かどうかなどの判定は e-Gov に任せて、そのエラーコードを返す。`lawId` に法令履歴ID（例 `322AC0000000049_20260717_508AC0000000060`）を渡せば、その版に固定できる。

### 3. 本文は法令XMLで受ける

`law_data` には `response_format=json&law_full_text_format=xml` を付ける。メタ情報（`law_info`・`revision_info`）は JSON で受け、本文は Base64 の法令XMLを復号する。試行版の JSON 本文に依存せず、v0.1 と同じ要素名の XML を平文にする処理をそのまま使える。CodeAgent の法令ベンチも同じ指定で取得している。

### 4. 出典情報

v0.1 の `source.name`・`url`・`apiUrl`・`attribution`・`retrievedAt` を保ち、`api`（法令API Version 2）・`lawId`・`lawRevisionId`・`amendmentEnforcementDate`・`asof`・`processing`（法令XMLからタグを除いて平文にした旨）を足す。`apiUrl` はクエリまで含む実際のURLで、同じ版を取り直せる。キャッシュから返すときも `retrievedAt` は e-Gov から実際に取得した時刻にする。`url` は e-Gov法令検索の法令ページ（現行版）のまま。

### 5. パスのホワイトリスト

`/api/1/` の前方一致をやめ、`/api/2/laws` と `/api/2/law_data/{1セグメント}` だけを許す正規表現にする。組み立てた文字列と、URL 解決後の `pathname` の両方で確かめる。`..` と `//` の拒否、e-Gov 以外のオリジンの拒否、リダイレクトの拒否は従来どおり。法令ID・法令番号は `encodeURIComponent` でパスに入れる。

### 6. 問い合わせ間隔とキャッシュ

e-Gov の資料に頻度の定めは見当たらない。ただ v0.1 は一覧を1回取れば後は通信しなかったのに対し、v0.2 は検索ごとに通信する。そこで自主的に、e-Gov への fetch をプロセス内の1本の Promise チェーンで直列化し、前の問い合わせの完了（失敗を含む）から1000ms以上あけて送る。`EGOV_LAW_MCP_INTERVAL_MS` で延ばせ、1000未満は無視する。同じURLは5分キャッシュし（最大20件、200万文字を超える応答は保持しない）、待ち中・取得中の同じ問い合わせは結果を共有する。タイムアウトは送信時から数える。形は houan-mcp ADR 0004 にそろえた。

### 7. 互換性

- 変えない：ツール名、必須入力、既存の入力名、既存の出力フィールド名。
- 足す：`asof` 入力。出力の `lawTitle`・`lawRevisionId`・`abbreviations`・`lawType`・`articleTitle`・`articleCaption`・`elm`・`matchedCount`・`truncated`（検索系）・`source` の追加項目。
- 変える：
  - `promulgationDate` を v2 の `YYYY-MM-DD` にする（v1 は `yyyyMMdd`）。同じ応答の `asof` と形式をそろえるため。
  - `search_laws` は e-Gov 側の部分一致で絞り込むので、略称でも当たり、結果が v0.1 と変わりうる。手元で順位付けするのは500件まで。`cacheFetchedAt` は残し、その検索に使ったデータの取得時刻を入れる。
  - `find_related_laws` は語幹を共有する法令だけを候補にする。v0.1 は基準の法令名に短い法令名がたまたま含まれるだけの無関係な法令も拾えた。
  - `get_article` を `lawNum` で呼んだときも `lawId` が入る（v1 は空だった）。`paragraph` は番号として検証する。
  - エラー文に e-Gov のコードを含める。
- 版は 0.2.0 にする。0.x 系なので、挙動の変更はマイナー番号を上げて示す。
- 旧ツールを残す・別名を足すことはしない。

### 8. テスト

`npm test`（`node --test test/*.test.mjs`）。fetch だけを差し替えた実際のサーバープロセスに対し、送るパラメータ、出力項目、`asof` と法令履歴ID、入力検証、e-Gov のエラーコード、間隔、キャッシュを確かめる。全テストで、要求先が `/api/2/laws` か `/api/2/law_data/{id}` だけであることも確かめる。

## Consequences

### 良い点

- ベンチの正解と同じ版の条文を、`asof` か法令履歴IDで MCP から取れる。出典に法令履歴IDが残る。
- 略称（通称）で検索・関連法令探索ができる。v0.1 は題名だけを照合するので `個人情報保護法` は0件になる（v2 の `law_title=個人情報保護法` が返した3件はいずれも略称での一致で、題名に含む現行法令はなかった）。
- 最初の検索で全件の一覧（`lawlists/1`。移行記事の 2026-09-14 の計測で 2,794,325 バイト）を落とさなくなった。

### 悪い点

- 検索ごとに通信し、続けて呼ぶと2件目以降は1件ごとに約1秒待つ。
- 1回の検索で順位付けするのは500件まで。広すぎる語では e-Gov の並び順（法令ID順）の先頭500件だけが対象になる（`truncated: true` で示す）。
- `promulgationDate` の形式が変わる。文字列で比較していた利用者には非互換。
- 検索結果が v2 の `law_title` 部分一致の挙動（表記ゆれの扱いなど）に左右される。
- 本文を Base64 で受けるぶん、転送量が増える。
- 直列化はプロセス単位。複数のクライアントがそれぞれ起動した場合の合計は制御できない（README に明記）。

## Alternatives Considered

### v1 のまま使い続ける

提供終了の告知はなく当面は動くが、時点指定ができずベンチを再現できない。却下。

### 本文を JSON（`json_format=full` / `light`）で受ける

OpenAPI 定義が試行版と明記している。却下。

### 応答全体を XML（`response_format=xml`）で受ける

Base64 は避けられるが、`law_info`・`revision_info` を正規表現で拾うことになる。JSON の方が項目を確実に取り出せる。`law_file/xml` は本文だけでメタ情報がない。却下。

### 全件の一覧を `laws` のページングで集め、v0.1 と同じく手元で検索する

既定の `limit` 100 では約90回、500 でも約20回の問い合わせが要る。e-Gov の負荷と待ち時間が大きい。却下。

### 旧ツールを残し、v2 用の新ツールを足す

ツールが倍になり、LLM がどちらを使うか迷う。入出力名を保ったまま中身を移せば、利用者は設定を変えずに済む。却下。

### 問い合わせ間隔を設けない

v0.2 は検索ごとに通信するので、LLM が並列に呼ぶと短時間に問い合わせが重なる。却下。

## References

- 法令API Version 2 OpenAPI 定義（version 2.1.139、2026-10-29 取得）：<https://laws.e-gov.go.jp/api/2/swagger-ui/lawapi-v2.yaml>
- お知らせ | e-Gov法令検索（2026-10-29 取得）：<https://laws.e-gov.go.jp/news/>
- 利用規約 | e-Gov法令検索：<https://laws.e-gov.go.jp/terms/>
- e-Gov法令API v1からv2への移行ガイド（codeagent.jp、2026-09-14 確認）：<https://codeagent.jp/posts/egov-law-api-v1-to-v2-migration/>
- houan-mcp ADR 0004：NDL Kokkai API への問い合わせを直列化し、3秒以上あける
