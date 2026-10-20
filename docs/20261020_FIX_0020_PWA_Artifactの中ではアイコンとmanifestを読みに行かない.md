# Artifact の中ではアイコンと manifest を読みに行かない

- 管理番号: #0020
- 種類: FIX（軽微な修正）
- 対象: PWA（`index.html` の `<head>`）
- 作成日: 2026-10-20
- 関連: #0005（PWA化と公開用の素材）、#0009（Artifact の中では「画像を保存」を出さない）

## 概要

`<head>` に直接書いていた `<link rel="apple-touch-icon">` と `<link rel="manifest">` を、ページを直接開いたときだけ置くようにした。Claude Artifact のような iframe・sandbox の中では、ホーム画面への追加はできず、ブラウザがこの2つを読みに行くと Content Security Policy に止められ、コンソールにエラーが出ていた。兄弟アプリ「段取り名人」（`段取り名人/`）の PWA 化の確認で見つかり、同じ直し方をこちらにも入れた。

## 対象ファイル

- `index.html`

## 変更内容

### 1. 2つの `<link>` を、小さなスクリプトで置く形に変えた

`<head>` の中で、`window.self !== window.top`（iframe の中）か `window.origin === 'null'`（sandbox）なら何もしない。それ以外（GitHub Pages・ホーム画面に追加したアプリ・ローカル）では、これまでと同じ `apple-touch-icon.png` と `manifest.json` の `<link>` を `<head>` に足す。判定は Service Worker の登録（`registerSW`）や `FRAMED` と同じ考え方。

GitHub Pages で直接開いたときの動き（ホーム画面に追加・アイコン・PWA）は変わらない。`sw.js` が先にキャッシュするファイルの一覧も変えていないので、`sw.js` の版は上げない。

## 確認

- `node tools/check-app.mjs index.html`: PASS 121項目
- `node tools/check-engine.mjs index.html`: PASS 82項目（1回目は、同じ Mac でほかの重い処理が動いていたため「性能: 最大300ms以下」だけ FAIL。もう一度流して PASS。エンジンは変えていない）
- 公開後に、GitHub Pages の `index.html` で2つの `<link>` が置かれることを確かめる（下の「確認URL」）

## 確認URL

| 環境 | URL |
|------|-----|
| 本番（GitHub Pages） | https://kiyotake1229.github.io/usotsuki-mura/ |
| 開発確認用（Claude Artifact） | https://claude.ai/artifact/BRWf8oJikTLt1mrkdA83Di |

## 作業概要と概算費用

| 項目 | 内容 | 工数 |
|------|------|------|
| 実装 | `<head>` の2つの `<link>` をスクリプトで置く形に | 0.1h |
| テスト | 両方のテスト、公開後の確認 | 0.2h |
| 文書 | この文書 | 0.1h |
| 合計 | | 0.4h（約0.05人日） |

概算費用: 人日単価が未設定のため金額は書かない。
