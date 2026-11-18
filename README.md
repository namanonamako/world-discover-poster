# World Discover Poster (VRChat World紹介ポスター自動生成)

X（旧Twitter）に投稿されたVRChatのワールド紹介投稿を Weir API で自動収集・キャプチャし、一枚のポスター画像（一覧画像）として合成・出力するシステムです。
IFTTT や外部収集サーバーに依存せず、GitHub Actions と GitHub Pages による単独構成で定期実行とデプロイを完全自動で行います。

## ✨ 主な機能

- **Weir API による単独収集**: `POST https://api.weirapp.io/v1/x/search` を直接呼び出して `#VRChat_world紹介` / `#VRChat_quest_world` 投稿を取得します。
- **マルチプラットフォーム対応 & Quest 自動判定**: `PC` 向けと `Quest` 向けを別々に収集・合成（各最大36枚）します。`vrc-api-proxy` が設定されている場合は、`#VRChat_world紹介` 投稿から抽出したワールド ID を照会して `android` 対応ワールドを自動で `Quest` 側にも追加します。
- **スパム・ブラックリスト除外**: ハッシュタグが5個以上の投稿をスパムとして除外し、`BLACKLIST` に指定された対象をスキップします。
- **ダークモード / ライトモード対応**: 埋め込み表示をライト／ダークの両テーマでキャプチャし、2種類のポスター画像を生成します。
- **完全自動化**: GitHub Actions により、状態管理（`posterState.json`）の復元から画像生成・GitHub Pages デプロイまでを自動実行します。

## 🛠 使用技術・動作環境

- **Node.js (`>=24.0.0`)**: アプリケーション本体・収集スクリプト・ユニットテスト（ワークフローでは Node.js 24 を使用）
- **Weir API**: X 投稿の検索・取得（`POST https://api.weirapp.io/v1/x/search`）
- **vrc-api-proxy**（任意）: VRChat ワールドの Quest 対応判定（`GET /api/1/worlds/{worldId}`）
- **Puppeteer**: X の oEmbed API（`https://publish.x.com/oembed`）を用いた埋め込みレンダリング＆スクリーンショット撮影
- **@napi-rs/canvas**: 取得したスクリーンショットを 2×3 タイル状のポスター画像へ合成
- **GitHub Actions / GitHub Pages**: 定期実行・CI 検証・生成物および状態ファイルのホスティング

## 🚀 動作の仕組み（処理フロー）

ワークフロー（`.github/workflows/update-pages.yml`）は `build` → `deploy` の2ジョブ構成で動作します。

1. **前回アセット・`posterState.json` の復元**
   - GitHub Pages から前回の個別画像（`work/base_{PC|Quest}_{0..35}.jpg` / `work/base_{PC|Quest}_d_{0..35}.jpg`）、`work/posterInfo.json`、`work/posterState.json` を `work/` ディレクトリに復元します。
2. **X 投稿収集・解析（`node src/collect.js`）**
   - `work/posterState.json` の `lastTweetId`（未設定時は直近24時間）を基準に Weir API（`POST https://api.weirapp.io/v1/x/search`）で対象投稿を検索します。
   - `BLACKLIST` 照合およびスパム判定（ハッシュタグ5個以上を除外）を行います。
   - `src/world-id-extractor.js` と `src/url-expander.js` により、直リンクや短縮 URL を安全に展開してワールド ID（`wrld_...`）を抽出します。
   - `VRC_PROXY_URL` と `VRC_PROXY_AUTH_TOKEN` が設定されている場合、`src/vrchat-client.js` 経由で `vrc-api-proxy` に問い合わせて Quest 対応を自動判定します（判定結果は `worldCache` に7日間キャッシュ）。
   - 収集結果を `work/posterData.json`、次回用状態を `work/nextPosterState.json` として保存します。
3. **埋め込み描画・タイル合成（`node app.js`）**
   - `work/posterData.json` を読み込み、`src/embed-guard.js` による oEmbed HTML・リクエスト先検証を行いつつ、Puppeteer でライトモード／ダークモードのスクリーンショットを撮影します（画像または `vrchat.com` リンクを含まない投稿はスキップ）。
   - 新規撮影分が36枚に満たない枠は `work/` に復元した前回画像で補完し、`@napi-rs/canvas` で 2×3 タイル（各タイル 550×800）に合成して `images/` ディレクトリに出力します（`{PC|Quest}_{0..5}.jpg` / `{PC|Quest}_d_{0..5}.jpg`）。
   - 前回分をマージした `images/posterInfo.json` と、次回実行用の `images/posterState.json` を出力します。
4. **GitHub Pages デプロイ（`deploy` ジョブ）**
   - `actions/upload-pages-artifact` および `actions/deploy-pages` により、`images/` ディレクトリを GitHub Pages にデプロイします。

## ⚙️ セットアップと設定

このリポジトリは GitHub Actions 上で動作するように設計されており、リポジトリ設定に Secrets と Variables を登録するだけで運用できます。

### 必要な GitHub Secrets

リポジトリの **Settings → Secrets and variables → Actions → Secrets** に以下を設定します。

- **`WEIR_API_KEY`** (必須): Weir API（`POST https://api.weirapp.io/v1/x/search`）の Bearer 認証用 API キー。
- **`VRC_PROXY_URL`** (任意): `vrc-api-proxy` のベース URL（`https://` 必須。ローカルテスト時のみ `http://localhost` 等を許可）。`VRC_PROXY_AUTH_TOKEN` と両方設定されている場合のみ Quest 自動判定が有効になります。
- **`VRC_PROXY_AUTH_TOKEN`** (任意): `vrc-api-proxy` への Bearer 認証トークン。

### GitHub Variables

リポジトリの **Settings → Secrets and variables → Actions → Variables** に以下を設定します。

- **`BLACKLIST`** (任意): 除外対象とするツイート URL の部分文字列やユーザー名をカンマ区切りで指定します（大文字・小文字を区別しません）。

### 実行スケジュールとワークフロー

- **`.github/workflows/update-pages.yml` (`Publish GitHub Pages`)**
  - `schedule`: `cron: '17,47 * * * *'`（毎時17分・47分の **30分毎** に自動実行）
  - `workflow_dispatch`: 手動実行に対応
- **`.github/workflows/ci.yml` (`CI`)**
  - `main` ブランチへの `push` / `pull_request` 時に、`app.js`・`src/*.js` の構文チェック（`node --check`）とユニットテスト（`npm test`）を実行
- **`.github/workflows/keepalive.yml` (`Keepalive Workflow`)**
  - `schedule`: `cron: '0 0 1 * *'`（毎月1日）および `workflow_dispatch` でスケジュール実行停止防止用の空コミットを実行

## 🧪 ローカル実行・テスト

ローカル環境（Node.js `>=24.0.0`）では以下のコマンドを利用できます。

```bash
# 依存パッケージのインストール
npm ci

# 投稿収集・posterData.json / nextPosterState.json 生成のみ実行
npm run collect   # node src/collect.js

# ポスター画像生成・合成を実行
npm start         # node app.js（Puppeteer の詳細ログを出す場合は DEBUG_PUPPETEER=true を指定）

# ユニットテストの実行
npm test          # node --test tests/*.test.js
```

## 🔄 旧構成からの移行・停止案内

Weir API + GitHub Actions 単独構成への移行に伴い、旧構成（v1 系）で使用していた以下の外部サービス・設定は不要になりました。重複課金や不要なリクエストを防ぐため、停止・削除を行ってください。

- **IFTTT**: X 投稿を外部サーバーへ送信するアプレットを停止・削除してください。
- **`discovery-poster-collector`（旧外部収集サーバー）**: 投稿収集・状態保持を本リポジトリの GitHub Actions / GitHub Pages へ統合したため不要です。サーバーを停止・廃止してください。
- **`WORLD_INTRODUCTION_API_KEY`（旧 GitHub Secret）**: 旧外部サーバー向けの認証キーは使用しないため、GitHub Secrets から削除し、代わりに `WEIR_API_KEY`（および Quest 自動判定を使う場合は `VRC_PROXY_URL`・`VRC_PROXY_AUTH_TOKEN`）を設定してください。
- **`BLACKLIST` の設定先変更**: 旧構成では Secrets に設定していましたが、現行ワークフローでは **Variables**（`vars.BLACKLIST`）を参照します。Secrets に残っている場合は Variables へ移行してください。
