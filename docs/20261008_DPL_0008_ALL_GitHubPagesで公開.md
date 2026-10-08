# GitHub Pages で公開

- 管理番号: #0008
- 種類: DPL（デプロイ）
- 対象: 全体（ALL）
- 作成日: 2026-10-08
- 関連: #0005（PWA化と公開用の素材）、#0006（iOSアプリ化）、#0007（リリース前の点検）、#0009（Artifact の中の保存ボタン）

## 概要

このフォルダを git リポジトリにして GitHub の公開リポジトリ `kiyotake1229/usotsuki-mura` に push し、main ブランチのルートを GitHub Pages で公開した。あわせて GitHub Actions の「iOS build check」で、iOS アプリがシミュレータ向け・実機向け（署名なし）ともにビルドできることを確かめた。開発確認用の Claude Artifact も最新の版で公開し直した。

## 対象ファイル

- フォルダ全体（`.gitignore` の対象を除く）。公開サイトに出すのは `index.html`・`manifest.json`・`sw.js`・アイコン・`ogp.png`・`support.html`
- `_config.yml`（#0007 で作成）で `README.md`・`docs/`・`ios-app/`・`tools/` を公開サイトから外している

## 変更内容

### 1. リポジトリ

- `git init -b main` で始め、最初のコミット「[#0008] 初版を GitHub Pages で公開（#0001〜#0007 を含む）」を push した
- リポジトリ: https://github.com/kiyotake1229/usotsuki-mura （公開。兄弟アプリ goi-dojo・maze-puzzle・senda・habit-app と同じ形）
- 最初の push は App Store 用スクリーンショット（約17MB）があるため途中で切れた。このリポジトリだけ `git config http.postBuffer 524288000` を設定して push し直した
- 今後は `index.html` などを直したらコミットして push すれば、数十秒で公開サイトに反映される

### 2. GitHub Pages

- 設定: ブランチ `main`・フォルダ `/`（`gh api -X POST repos/kiyotake1229/usotsuki-mura/pages`）
- `.nojekyll` は置かない。置くと `_config.yml` の `exclude` が効かず、`docs/` なども公開サイトで開けてしまう
- 「pages build and deployment」は成功

### 3. iOS ビルド確認（GitHub Actions）

- ワークフロー: `.github/workflows/ios-build.yml`（#0006・#0007）
- 結果: 成功。https://github.com/kiyotake1229/usotsuki-mura/actions/runs/37770709497
  - `npm ci` → `npm run sync-web` → `npx cap sync ios`（pod install）→ シミュレータ向け Debug ビルド `** BUILD SUCCEEDED **` → 実機向け Release ビルド（署名なし）`** BUILD SUCCEEDED **` → アプリの中身の確認
- 注意（動作には影響なし）: GitHub から「actions/checkout@v4・actions/setup-node@v4 は Node.js 20 向けで、Node.js 24 で動かしている」という知らせが出ている。いずれ v5 などに上げる

## 確認

- 公開サイト（curl）: `/`・`index.html`・`manifest.json`・`sw.js`・`icon-192.png`・`icon-512.png`・`apple-touch-icon.png`・`icon.svg`・`ogp.png`・`support.html` が 200。`README.md`・`docs/README.md`・`ios-app/README.md`・`tools/check-engine.mjs` は 404（公開サイトに出ていない）
- 公開サイトの `index.html`・`sw.js`・`support.html` は手元のファイルと同じ中身（shasum が一致。Jekyll で書き換わっていない）
- アプリ内の Browser でスマホ幅（375×812）で公開URLを開いた（音は消してから操作）: 今日の事件 No.8 が表示、Service Worker が `https://kiyotake1229.github.io/usotsuki-mura/` の範囲で登録され、キャッシュ `usotsuki-app-v2` ができた。同じドメインのほかのアプリのキャッシュ（mahjong・maze など）は消えていない。コンソールのエラー0件
- `node tools/check-engine.mjs index.html`: PASS
- Claude Artifact: 最新の版で公開し直した（Version 3）。Claude の確認用ブラウザは claude.ai にログインしていないため、Artifact の画面そのものは開けていない
- 未確認: スマホ実機（iPhone Safari・Android Chrome でのホーム画面に追加・オフライン・Web Share）、SNS に URL を貼ったときのプレビュー画像の表示、Xcode での実機ビルドと App Store 申請

## 確認URL

| 環境 | URL |
|------|-----|
| ローカル | http://127.0.0.1:8793/ （このフォルダで `python3 -m http.server 8793 --bind 127.0.0.1`） |
| 開発確認用（Claude Artifact） | https://claude.ai/artifact/BRWf8oJikTLt1mrkdA83Di |
| 本番（GitHub Pages） | https://kiyotake1229.github.io/usotsuki-mura/ |
| サポート（App Store 用） | https://kiyotake1229.github.io/usotsuki-mura/support.html |
| iOS ビルド確認 | https://github.com/kiyotake1229/usotsuki-mura/actions/runs/37770709497 |

## 作業概要と概算費用

| 項目 | 内容 | 工数 |
|------|------|------|
| 準備 | 公開してよい中身の確認（秘密情報・作業用ファイル・`.gitignore`）、兄弟アプリの公開の形の確認 | 0.3h |
| 公開 | リポジトリ作成・push・Pages の設定 | 0.3h |
| 確認 | 公開サイトの応答と中身、ブラウザでの表示・Service Worker、iOS ビルドの結果 | 0.5h |
| 文書 | この文書、README の更新 | 0.3h |
| 合計 | | 1.4h（約0.2人日） |

概算費用: 人日単価が未設定のため金額は書かない。外部費用なし（GitHub の無料の範囲）。
