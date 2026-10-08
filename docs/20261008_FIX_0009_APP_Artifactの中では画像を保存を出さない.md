# Artifact の中では「画像を保存」を出さない

- 管理番号: #0009
- 種類: FIX（軽微な修正）
- 対象: アプリ本体（APP）
- 作成日: 2026-10-08
- 関連: #0004（結果の共有画像）、#0008（公開）

## 概要

結果の画像の画面にある［画像を保存］は、`<a download>` のリンクで画像を保存する。Claude Artifact の中（iframe・sandbox）ではこのリンクが働かず、押しても何も起きない。Artifact の中ではこのボタンを出さないようにした。GitHub Pages・ホーム画面に追加したアプリ・PC のブラウザでは、これまでどおり出る。画像の長押し（PC は右クリック）での保存の案内は、どの環境でも出る。

## 対象ファイル

- `index.html`

## 変更内容

### 1. iframe・sandbox の中かを判定する `FRAMED` を追加

`NATIVE` の定義のすぐ下に `FRAMED`（`window.self !== window.top` か `window.origin === 'null'`。判定で例外が出たら iframe の中とみなす）を足した。Service Worker の登録を止める条件（`registerSW()`）と同じ考え方。

### 2. ［画像で共有］の画面で、`NATIVE` か `FRAMED` のときは［画像を保存］を出さない

`openShareView()` のボタンの並びで、［画像を保存］の条件を `NATIVE` から `NATIVE || FRAMED` にした。ボタンの数が変わると［結果に戻る］の並び方（横に並べるか1行に広げるか）は今の仕組みのまま自動で決まる。

## 確認

- `node tools/check-engine.mjs index.html --count 40 --days 20`: PASS（エンジンは変えていない）
- ローカル（http://127.0.0.1:8793/、iframe の外）で開き、ページが表示されコンソールのエラーが0件であること
- Artifact に公開し直した（Version 3）。Artifact の公開ツールは、ページのソースに download のリンクがあるので注意を出し続けるが、実際の画面では iframe の中なのでボタンは出ない
- 未確認: Artifact の画面そのものを開いての確認（Claude の確認用ブラウザが claude.ai にログインしていないため）

## 確認URL

| 環境 | URL |
|------|-----|
| ローカル | http://127.0.0.1:8793/ （このフォルダで `python3 -m http.server 8793 --bind 127.0.0.1`） |
| 開発確認用（Claude Artifact） | https://claude.ai/artifact/BRWf8oJikTLt1mrkdA83Di |
| 本番（GitHub Pages） | https://kiyotake1229.github.io/usotsuki-mura/ |

## 作業概要と概算費用

| 項目 | 内容 | 工数 |
|------|------|------|
| 実装 | `FRAMED` の追加とボタンの条件 | 0.2h |
| テスト | エンジンの検査、ローカルでの表示確認 | 0.1h |
| 文書 | この文書 | 0.1h |
| 合計 | | 0.4h（約0.05人日） |

概算費用: 人日単価が未設定のため金額は書かない。
