# 嘘つき村の事件簿 iOSアプリ（Capacitor 7）

1つ上のフォルダの Web アプリ本体（`../index.html`）を、そのまま iOS アプリに同梱するためのプロジェクト。

- **ビルド・App Store 申請の手順（岩崎さん向け）** → [岩崎さんへの引き渡し手順.md](岩崎さんへの引き渡し手順.md)
- 開発の記録 → [../docs/20261008_NEW_0006_IOS_iOSアプリ化.md](../docs/20261008_NEW_0006_IOS_iOSアプリ化.md)

| 項目 | 内容 |
|------|------|
| Bundle ID / 表示名 | `work.ltv.usotsuki` / ホーム画面は「嘘つき村」（`Info.plist`） |
| 対応 | iPhone・縦向きのみ（iOS 14 以上） |
| プラグイン | App / Haptics / LocalNotifications / Preferences / Share / Filesystem / StatusBar（すべて 7 系） |
| ビルド確認 | GitHub Actions（`../.github/workflows/ios-build.yml`）。手元の Mac には Xcode が無い |

## よく使うコマンド（このフォルダで実行）

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # 日本語のパスで CocoaPods が止まらないように
npm install        # 最初に1回（node_modules は Dropbox が重くなるので消してある）
npm run sync       # ../index.html の変更を iOS 側へ反映（www/ へコピー → cap sync → pod install）
npm run open       # Xcode で開く（ios/App/App.xcworkspace。要 Xcode）
npm run icons      # assets/ の画像からアイコンと起動画面を作り直す
```

- `www/` と `ios/App/App/public/` は `npm run sync` が作るコピー。直接は編集しない（`.gitignore` 対象）
- `screenshots/` は App Store 用のスクリーンショット（6.7 / 6.5 / 5.5 インチ × 6枚。中身は `screenshots/README.md`）
- `assets/icon.png` は `../tools/make-images.py icons` が作る。`assets/splash.png` / `splash-dark.png` は起動画面（判子だけ）の元
- 使い終わったら `rm -rf node_modules ios/App/Pods` で消す（どちらも `npm install` / `npm run sync` で戻る）
