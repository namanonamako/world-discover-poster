# World Discover Poster (VRChat World紹介ポスター自動生成)

X（旧Twitter）に投稿されたVRChatのワールド紹介投稿を Weir API で自動収集・キャプチャし、一枚のポスター画像（一覧画像）として合成・出力するシステムです。
IFTTT や外部収集サーバーに依存せず、GitHub Actions と GitHub Pages で投稿収集・画像生成・デプロイを自動実行します（外部からの `repository_dispatch` 起動および手動実行に対応）。

## ✨ 主な機能

- **Weir API による単独収集**: `POST https://api.weirapp.io/v1/x/search` を直接呼び出して `#VRChat_world紹介` / `#VRChat_quest_world` 投稿を取得します。
- **マルチプラットフォーム対応 & Quest 自動判定**: `PC` 向けと `Quest` 向けを別々に収集・合成（各最大36枚）します。`vrc-api-proxy` が設定されている場合は、`#VRChat_world紹介` 投稿から抽出したワールド ID を照会して `android` 対応ワールドを自動で `Quest` 側にも追加します。
- **Workload Identity Federation + Secret Manager 連携（任意）**: `google-github-actions/auth` と `google-github-actions/get-secretmanager-secrets` により、長期的な GCP サービスアカウント鍵を保持せず OIDC で Google Cloud Secret Manager（`VRC_PROXY_TOKENS`）から `vrc-api-proxy` 用認証トークンを取得できます。
- **スパム・ブラックリスト除外**: ハッシュタグが5個以上の投稿をスパムとして除外し、`BLACKLIST` に指定された対象をスキップします。
- **ダークモード / ライトモード対応**: 埋め込み表示をライト／ダークの両テーマでキャプチャし、2種類のポスター画像を生成します。
- **完全自動化**: GitHub Actions により、状態管理（`posterState.json`）の復元から画像生成・GitHub Pages デプロイまでを自動実行します。

## 🛠 使用技術・動作環境

- **Node.js (`>=24.0.0`)**: アプリケーション本体・収集スクリプト・ユニットテスト（ワークフローでは Node.js 24 を使用）
- **Weir API**: X 投稿の検索・取得（`POST https://api.weirapp.io/v1/x/search`）
- **vrc-api-proxy**（任意）: VRChat ワールドの Quest 対応判定（`GET /api/1/worlds/{worldId}`）
- **Google Cloud Workload Identity Federation / Secret Manager**（任意）: `vrc-api-proxy` 認証トークン（`VRC_PROXY_TOKENS` 内 `API_AUTH_TOKEN`）の安全な取得
- **Puppeteer**: X の oEmbed API（`https://publish.x.com/oembed`）を用いた埋め込みレンダリング＆スクリーンショット撮影
- **@napi-rs/canvas**: 取得したスクリーンショットを 2×3 タイル状のポスター画像へ合成
- **GitHub Actions / GitHub Pages**: ワークフロー実行（`repository_dispatch` / `workflow_dispatch`）・CI 検証・生成物および状態ファイルのホスティング

## 🚀 動作の仕組み（処理フロー）

ワークフロー（`.github/workflows/update-pages.yml`）は `build`（`permissions: contents: read, id-token: write`）→ `deploy` の2ジョブ構成で動作します。

1. **前回アセット・`posterState.json` の復元**
   - GitHub Pages から前回の個別画像（`work/base_{PC|Quest}_{0..35}.jpg` / `work/base_{PC|Quest}_d_{0..35}.jpg`）、`work/posterInfo.json`、`work/posterState.json` を `work/` ディレクトリに復元します。
2. **GCP WIF 認証・Secret Manager からのトークン取得（任意）**
   - `secrets.WIF_PROVIDER`、`secrets.GCP_SA`、および `secrets.GCP_PROJECT_ID` または `vars.GCP_PROJECT_ID` がすべて設定されている場合、`google-github-actions/auth` による OIDC 認証を行います。
   - `google-github-actions/get-secretmanager-secrets` で `${GCP_PROJECT_ID}/VRC_PROXY_TOKENS` を取得し、`jq` で JSON 内の `.API_AUTH_TOKEN` を抽出、`::add-mask::` でログマスクした上で `steps.proxy_token.outputs.vrc_proxy_auth_token` に設定します。
   - 認証・取得直後（`always() && steps.gcp_auth.outcome == 'success'`）に、`GOOGLE_GHA_CREDS_PATH`・`GOOGLE_APPLICATION_CREDENTIALS`・`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` が指すファイル（および `.credential_source.file`）と `${GITHUB_WORKSPACE}/gha-creds-*.json` を削除し、これらの環境変数を空文字へリセットします。
3. **X 投稿収集・解析（`node src/collect.js`）**
   - `work/posterState.json` の `lastTweetId`（未設定時は直近24時間）を基準に Weir API（`POST https://api.weirapp.io/v1/x/search`）で対象投稿を検索します。
   - `BLACKLIST` 照合およびスパム判定（ハッシュタグ5個以上を除外）を行います。
   - `src/world-id-extractor.js` と `src/url-expander.js` により、直リンクや短縮 URL を安全に展開してワールド ID（`wrld_...`）を抽出します。
   - `src/vrchat-client.js` の `resolveProxyAuthToken()` が `VRC_PROXY_AUTH_TOKEN`（優先）または `VRC_PROXY_TOKENS` JSON 内の `API_AUTH_TOKEN` から認証トークンを解決します。`VRC_PROXY_URL` と認証トークンが両方有効な場合のみ、`vrc-api-proxy` に問い合わせて Quest 対応を自動判定します（判定結果は `worldCache` に7日間キャッシュ）。
   - 収集結果を `work/posterData.json`、次回用状態を `work/nextPosterState.json` として保存します。
4. **埋め込み描画・タイル合成（`node app.js`）**
   - GCP 認証用環境変数（`GOOGLE_APPLICATION_CREDENTIALS`、`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`、`GOOGLE_GHA_CREDS_PATH`）を明示的に空文字にした状態で実行されます。
   - `work/posterData.json` を読み込み、`src/embed-guard.js` による oEmbed HTML（状態機械ベース）・リクエスト先検証および CSP（`Content-Security-Policy`）`<meta>` 付与を行いつつ、Puppeteer でライトモード／ダークモードのスクリーンショットを撮影します（画像または `vrchat.com` リンクを含まない投稿はスキップ）。
   - 新規撮影分が36枚に満たない枠は `work/` に復元した前回画像で補完し、`@napi-rs/canvas` で 2×3 タイル（各タイル 550×800）に合成して `images/` ディレクトリに出力します（`{PC|Quest}_{0..5}.jpg` / `{PC|Quest}_d_{0..5}.jpg`）。
   - 前回分をマージした `images/posterInfo.json` と、次回実行用の `images/posterState.json` を出力します。
5. **GitHub Pages デプロイ（`deploy` ジョブ）**
   - `actions/upload-pages-artifact` および `actions/deploy-pages` により、`images/` ディレクトリを GitHub Pages にデプロイします。

## ⚙️ セットアップと設定

このリポジトリは GitHub Actions 上で動作するように設計されており、リポジトリの **Settings → Secrets and variables → Actions** に Secrets / Variables を登録するだけで運用できます。

### GitHub Secrets

- **`WEIR_API_KEY`** (必須): Weir API（`POST https://api.weirapp.io/v1/x/search`）の Bearer 認証用 API キー。
- **`WIF_PROVIDER`** (任意・GCP WIF 連携用): Google Cloud Workload Identity プロバイダのリソース名。
- **`GCP_SA`** (任意・GCP WIF 連携用): Secret Manager の参照権限（`roles/secretmanager.secretAccessor` 等）を持つサービスアカウントのメールアドレス。
- **`GCP_PROJECT_ID`** (任意・GCP WIF 連携用): Secret Manager（`VRC_PROXY_TOKENS`）を格納している GCP プロジェクト ID またはプロジェクト番号。Variables 側でも指定可能ですが、ワークフローでは `secrets.GCP_PROJECT_ID || vars.GCP_PROJECT_ID` の順で解決されます。
- **`VRC_PROXY_URL`** (任意): `vrc-api-proxy` のベース URL（`https://` 必須。ローカルテスト時のみ `http://localhost` / `http://127.0.0.1` / `http://[::1]` を許可）。Variables 側でも指定可能です（`vars.VRC_PROXY_URL || secrets.VRC_PROXY_URL`）。
- **`VRC_PROXY_AUTH_TOKEN`** (任意・直接指定 / フォールバック): `vrc-api-proxy` への Bearer 認証トークン。
  - **優先順位と削除に関する注意**: ワークフローでは `${{ secrets.VRC_PROXY_AUTH_TOKEN || steps.proxy_token.outputs.vrc_proxy_auth_token }}` の順で参照され、`src/vrchat-client.js` でも `VRC_PROXY_AUTH_TOKEN` が `VRC_PROXY_TOKENS` より優先されます。そのため、**Secret Manager（`VRC_PROXY_TOKENS`）運用へ移行した後は GitHub Secrets から `VRC_PROXY_AUTH_TOKEN` を削除してください**（残っている場合は常にそちらが優先されます）。

### GitHub Variables

- **`BLACKLIST`** (任意): 除外対象とするツイート URL の部分文字列やユーザー名をカンマ区切りで指定します（大文字・小文字を区別しません）。
- **`VRC_PROXY_URL`** (任意): `vrc-api-proxy` のベース URL。Secrets と両方設定されている場合は Variables（`vars.VRC_PROXY_URL`）が優先されます。
- **`GCP_PROJECT_ID`** (任意): Secret Manager 参照先の GCP プロジェクト ID または番号。Secrets と両方設定されている場合は Secrets（`secrets.GCP_PROJECT_ID`）が優先されます。

### Google Cloud Secret Manager の構成（WIF 連携利用時）

Quest 自動判定で GCP WIF 連携を利用する場合は、対象プロジェクトの Secret Manager に以下のシークレットを作成してください。

- **シークレット名**: `VRC_PROXY_TOKENS`
- **格納値（JSON）**: `API_AUTH_TOKEN` キーに `vrc-api-proxy` の Bearer トークンを設定した JSON 文字列

```json
{
  "API_AUTH_TOKEN": "<vrc-api-proxy-bearer-token>"
}
```

### ワークフローと起動トリガー

- **`.github/workflows/update-pages.yml` (`Publish GitHub Pages`)**
  - `repository_dispatch`（`types: [build_and_deploy]`）: 外部からのディスパッチイベント（`build_and_deploy`）を受けてビルドと GitHub Pages デプロイを実行
  - `workflow_dispatch`: 手動実行に対応
  - `schedule` トリガーを使用せず外部からの `repository_dispatch` 起動を維持する構成のため、`schedule` 自動停止防止用の `.github/workflows/keepalive.yml` は不要となり削除しました。
- **`.github/workflows/ci.yml` (`CI`)**
  - `main` ブランチへの `push` / `pull_request` 時に、`app.js`・`src/*.js` の構文チェック（`node --check`）とユニットテスト（`npm test`）を実行

## 🧪 ローカル実行・テスト

ローカル環境（Node.js `>=24.0.0`）では以下のコマンドを利用できます。

```bash
# 依存パッケージのインストール
npm ci

# 投稿収集・posterData.json / nextPosterState.json 生成のみ実行
npm run collect   # node src/collect.js

# ポスター画像生成・合成を実行
npm start         # node app.js（Puppeteer の詳細ログを出す場合は DEBUG_PUPPETEER=true を指定）

# ユニットテストの実行（tests/*.test.js の全7スイート・33テストを実行）
npm test          # node --test tests/*.test.js
```

### 主な環境変数（ローカル実行時）

- `WEIR_API_KEY`: Weir API キー（`npm run collect` で必須）
- `VRC_PROXY_URL`: `vrc-api-proxy` のベース URL（任意）
- `VRC_PROXY_AUTH_TOKEN`: `vrc-api-proxy` の Bearer 認証トークン（任意。指定時は `VRC_PROXY_TOKENS` より優先）
- `VRC_PROXY_TOKENS`: `{"API_AUTH_TOKEN":"..."}` 形式の JSON 文字列（任意。`VRC_PROXY_AUTH_TOKEN` 未設定時に参照）
- `BLACKLIST`: カンマ区切りの除外指定（任意）
- `DEBUG_PUPPETEER`: `"true"` を指定すると `app.js` 実行時に Puppeteer の詳細ログを出力（任意）

## 🔄 旧構成からの移行・停止案内

Weir API + GitHub Actions 単独構成への移行に伴い、旧構成（v1 系）で使用していた以下の外部サービス・設定は不要になりました。重複課金や不要なリクエストを防ぐため、停止・削除を行ってください。

- **IFTTT**: X 投稿を外部サーバーへ送信するアプレットを停止・削除してください。
- **`discovery-poster-collector`（旧外部収集サーバー）**: 投稿収集・状態保持を本リポジトリの GitHub Actions / GitHub Pages へ統合したため不要です。サーバーを停止・廃止してください。
- **`WORLD_INTRODUCTION_API_KEY`（旧 GitHub Secret）**: 旧外部サーバー向けの認証キーは使用しないため、GitHub Secrets から削除し、代わりに `WEIR_API_KEY`（および Quest 自動判定を使う場合は `VRC_PROXY_URL` と、GCP WIF + Secret Manager 用の `WIF_PROVIDER`・`GCP_SA`・`GCP_PROJECT_ID`、または直接指定用の `VRC_PROXY_AUTH_TOKEN`）を設定してください。
- **直接指定 `VRC_PROXY_AUTH_TOKEN` から Secret Manager 運用への移行**: `secrets.VRC_PROXY_AUTH_TOKEN` は Secret Manager（`VRC_PROXY_TOKENS`）より優先されるため、WIF 連携へ切り替えた後は GitHub Secrets の `VRC_PROXY_AUTH_TOKEN` を削除してください。
- **`BLACKLIST` の設定先変更**: 旧構成では Secrets に設定していましたが、現行ワークフローでは **Variables**（`vars.BLACKLIST`）を参照します。Secrets に残っている場合は Variables へ移行してください。
