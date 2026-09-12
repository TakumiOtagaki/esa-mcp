# esa-mcp

複数の esa.io team（workspace）を Codex CLI から横断検索・閲覧する read-only MCP server。Node.js と公式 MCP SDK を使い、stdio で通信します。esa への通信は公式 API v1 の GET のみです。記事・コメントの作成、編集、削除は実装していません。

## 1. インストール

Node.js 22 以上と npm、Codex CLI が必要です。このリポジトリを取得し、ディレクトリ内で実行します。

```sh
npm ci
npm test
```

ビルド不要です。手動起動は `npm start`、MCP クライアントからの起動には `node /absolute/path/esa-mcp/src/index.js` を使います。stdio server のため単独起動時は入力待ちになります。stdout は MCP 通信専用です。

## 2. ESA_ACCESS_TOKEN の設定

esa の `https://<所属team>.esa.io/user/applications` でアクセストークンを発行し、読み取り用の `read` scope と必要な team・カテゴリへのアクセスを許可します。横断対象は、その token から取得できる所属 team と記事に限られます。token のアクセスポリシーで制限された情報は取得できません。

macOS 標準の zsh では、次の入力プロンプトで token を設定できます（値は画面にもコマンド履歴にも残りません）。

```zsh
read -rs 'ESA_ACCESS_TOKEN?esa access token: '
export ESA_ACCESS_TOKEN
printf '\n'
```

bash の場合:

```bash
read -rsp 'esa access token: ' ESA_ACCESS_TOKEN
export ESA_ACCESS_TOKEN
printf '\n'
```

**同じシェルから Codex CLI を起動してください。** server は起動時の環境変数 `ESA_ACCESS_TOKEN` だけを読み取ります。`.env` の自動読み込みは行いません。token をソース、README、Codex 設定、コマンド引数に書き込む必要はありません。変更後は Codex/server を再起動します。

## 3. Codex CLI への登録

リポジトリのディレクトリ内で実行します。

```sh
codex mcp add esa -- node "$PWD/src/index.js"
```

続いて `~/.codex/config.toml` の生成された `[mcp_servers.esa]` に `env_vars` を追加します。最終形は以下です。`args` は実際の絶対パスに置き換え、同じテーブルを二重に追加しないでください。

```toml
[mcp_servers.esa]
command = "node"
args = ["/absolute/path/esa-mcp/src/index.js"]
env_vars = ["ESA_ACCESS_TOKEN"]
tool_timeout_sec = 120
```

`env_vars` は Codex の親プロセスの環境変数を server に渡す指定で、token 値は設定に保存されません。`--env ESA_ACCESS_TOKEN=...` は値を設定に保存するため使いません。`node` が見つからない場合は `command -v node` の絶対パスを `command` に指定します。

```sh
codex mcp list
codex mcp get esa
codex
```

Codex 内で `/mcp` を開き、`esa` と下記 5 tools を確認します。登録方法と環境変数転送は [Codex 公式 MCP ドキュメント](https://developers.openai.com/codex/mcp/) を参照してください。

## 4. 動作確認

認証情報も esa へのネットワーク接続も不要な確認:

```sh
npm test
npm run smoke
```

`smoke` は**実際に server を子プロセスで起動**し、公式 MCP client で initialize → tools/list → tools/call を実行します。5 tools の公開、read-only annotations、token 未設定時のエラーを検証し、プロセスを終了します。`npm test` にはモック API を使った横断検索・ページ継続・キャッシュ・エラー・Markdown 保持・MCP 入力検証も含みます。

実際の token で所属 team の取得まで確認する場合:

```sh
npm run smoke -- --live
```

この確認は `ESA_ACCESS_TOKEN` が必要です。成功時には所属 team 数だけを表示します。記事検索・全文・コメントは、下記の例を Codex に依頼して確認できます。

主なエラー:

| エラー | 確認事項 |
| --- | --- |
| `missing_token` | token を export したシェルから Codex を起動し、`env_vars` を設定したか |
| HTTP 401 / 403 | token の有効性、read scope、所属 team、アクセスポリシー |
| HTTP 404 | team のサブドメインと、その team 内の記事番号・閲覧権限 |
| `rate_limited` | `retry_after_seconds` 経過後に再実行 |
| `network_error` | 接続・タイムアウト。エラー原因の生データや token は出力しません |

## 5. Tools と使用例

| Tool | 引数 | 内容 |
| --- | --- | --- |
| `esa_list_teams` | `refresh?`（既定 false） | 所属 team を全ページ取得。60 秒キャッシュ |
| `esa_search_posts` | **`query`**、`team?` または `teams?`、`page?`、`per_page?` | esa 検索式で検索。team 未指定は全 team |
| `esa_get_post` | **`team`**、**`post_number`** | 記事全文の Markdown とメタデータ |
| `esa_list_recent_posts` | `team?` または `teams?`、`page?`、`per_page?` | team ごとの更新日時降順の記事一覧 |
| `esa_list_comments` | **`team`**、**`post_number`**、`page?`、`per_page?` | 記事コメントの Markdown 本文、投稿者、日時、URL |

`team` は表示名や URL ではなく `example.esa.io` の `example` です。`team` と `teams` の同時指定や空の `teams` はエラーです。重複 team は一度だけ問い合わせます。`query` は空白のみを許可せず、esa API の `q` に渡します。

Codex に依頼する例:

- 「esa の所属 team を一覧にして」
- 「所属する全 esa team から『オンボーディング』を検索し、team と記事 URL を並べて」
- 「esa の alpha と beta の team で `category:開発 API` を検索して」
- 「esa の alpha team の記事 #42 を全文読んで要約して」
- 「全 esa team の最近更新された記事を team ごとに 5 件ずつ見せて」
- 「alpha team の記事 #42 のコメントを読んで」

MCP tool の引数例（架空の team / 記事番号）:

```json
{ "query": "オンボーディング" }
```

```json
{ "query": "category:開発 API", "teams": ["alpha", "beta"], "per_page": 10 }
```

```json
{ "team": "alpha", "post_number": 42 }
```

検索と最近の記事は `results` に team ごとのページを返します。各記事に `team`、`post_number`、`title`、`category`、`updated_at`、`url`、`excerpt` が含まれます。記事番号は team 内でのみ一意です。全文は読みやすい Markdown の text content と、`body_md` を含む structured content の両方で返し、省略しません。

## Pagination と API request 数

`page` は既定 1、`per_page` は既定 20、最大 100 です。件数は**team ごと**で、全 team を合わせた上限ではありません。記事・コメントは 1 回の呼び出しにつき各対象の 1 ページを返し、`page`、`per_page`、`next_page`、`prev_page`、`total_count` を保持します。`has_more` が true なら続きがあります。

続きは `next_page` がある team のみ、同じ `query` と `per_page` で呼び出します。例えば alpha の `next_page: 2` に対して:

```json
{ "query": "オンボーディング", "team": "alpha", "page": 2, "per_page": 20 }
```

`next_page: null` になるまで続ければ全件を辿れます。コメントも同様です。team により次ページが異なる場合は個別に続行します。esa のページ番号方式のため、ページ取得中に記事が更新されると重複・欠落が生じ得ます。固定時点のスナップショットは保証しません。

- team 一覧だけは `per_page=100` と API の `next_page` で最後まで自動取得します。成功した一覧を 60 秒メモリキャッシュし、同時取得は共有します。所属変更は `refresh: true` で反映できます。
- 記事一覧は対象 team 数だけの API 呼び出しです。team 指定時には所属一覧を取得しません。抜粋は一覧に含まれる本文の冒頭から最大 240 文字を作り、個別記事の追加取得はしません。
- 抜粋は空白をまとめた Markdown の冒頭です。検索語のハイライトではありません。検索・最近の記事は各 team 内で更新日時降順です。
- API request は server 全体で直列化し、各リクエストは 15 秒でタイムアウトします。自動リトライはしません。429 または残りリクエスト数 0 を検出すると、応答ヘッダに基づく待機期限まで追加リクエストを抑止します（期限不明時は 60 秒）。
- 一部 team の取得失敗は `partial: true` と team ごとの `error` で返します。成功した結果は残ります。全対象失敗の場合は MCP の `isError` も true です。エラーを検索結果ゼロとして扱わないでください。
- team 数が多い場合は `teams` で分割すると応答時間と出力量を抑えられます。記事本文と token はディスクにキャッシュしません。

## 実装範囲と参考資料

通信先は `https://api.esa.io/v1` に固定し、GET のみを使い、HTTP redirect は追跡しません。認証は Authorization header で送信します。MCP tool はすべて read-only として公開されます。記事内のリンクや命令を server が実行することはありません。

- [esa 公式 API v1](https://docs.esa.io/posts/102): 認証、team、記事、コメント、pagination、rate limit
- [esa 記事の検索方法](https://docs.esa.io/posts/104): `query` に使用する検索式
- [公式 MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

ファイル構成: `src/esa-client.js` が API・キャッシュ、`src/server.js` が tool 定義、`src/index.js` が stdio 起動、`test/` がテスト、`scripts/smoke.js` が実プロセスの接続確認です。
