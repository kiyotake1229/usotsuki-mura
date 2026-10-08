# プレゼン資料（社内説明・9枚）

- 公開URL（Claude の Slides。発表・文字の修正・PDF / PowerPoint の書き出し）: https://claude.ai/artifact/TMgWGaybyDJ2xfoNuNdvx9
- PDF: `嘘つき村の事件簿_社内説明.pdf`（このフォルダ。そのまま配れる）
- 話す台本: [../プレゼンの進め方.md](../プレゼンの進め方.md)
- 見た目はアプリ本体（index.html）と同じ配色（藍のインク・朱の判子・和紙の紙面）と書体（しっぽり明朝 B1 / Zen Kaku Gothic New）
- 構成: 表紙 / ねらい / 遊び方（例題4人） / 考え方（例題の解説） / 問題の作り方 / 遊べる種類 / 続ける仕掛け / 現状 / 次のステップとお願い

## ファイル

| ファイル | 中身 |
|---|---|
| `project/deck.json` | 題名・スライドの並び順・書体 |
| `project/slides/<id>.html` | スライド1枚ずつ（1920×1080）。最後の `<aside>` は話す内容のメモ |
| `make-pdf.py` | `project/` から PDF を作るスクリプト |
| `嘘つき村の事件簿_社内説明.pdf` | 配布用の PDF |

## 文言を直す

1. `project/slides/<id>.html` を直す（または公開URLの画面で直接直す）
2. 公開URLにも反映する（Claude に「スライドのこの部分を直して」と頼めば、同じURLのまま更新される）
3. PDF を作り直す（Google Chrome が必要）

```bash
python3 資料/プレゼン資料/make-pdf.py
```

公開URLの画面で直接直した場合は、手元の `project/` が古くなる。そのときは Claude に「公開中のスライドを手元の project/ に読み戻して」と頼んでから PDF を作り直す。
PDF はブラウザでそのまま印刷して作っているので、公開URLの画面と細かい見た目（表の罫線など）が少し違うことがある。
