#!/bin/bash
# docs/manager/generate_docs_json.sh
# docs/ 配下の .md ファイルからドキュメント一覧 JSON を生成する
#
# 使い方: このスクリプトを docs/manager/ に配置して実行
#   bash docs/manager/generate_docs_json.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCS_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT="$SCRIPT_DIR/docs.json"

# 既存の next_no を保持（ファイルが存在する場合）
CURRENT_NEXT_NO=1
if [ -f "$OUTPUT" ]; then
    CURRENT_NEXT_NO=$(python3 -c "
import json
with open('$OUTPUT') as f:
    data = json.load(f)
print(data.get('next_no', 1))
" 2>/dev/null || echo 1)
fi

# ドキュメント一覧を生成
export DOCS_DIR OUTPUT CURRENT_NEXT_NO
python3 << 'PYTHON_SCRIPT'
import os
import json
import re
from pathlib import Path

docs_dir = Path(os.environ.get('DOCS_DIR', '.'))
output_path = Path(os.environ.get('OUTPUT', 'docs.json'))
current_next_no = int(os.environ.get('CURRENT_NEXT_NO', '1'))

# YYYYMMDD_TYPE_NNNN_CAT_TITLE.md パターン
pattern = re.compile(r'^(\d{8})_([A-Z]{3})_(\d{4})_([A-Z]{2,4})_(.+)\.(md|pdf|html)$')

documents = []
max_no = 0

for f in sorted(docs_dir.iterdir()):
    if not f.is_file():
        continue
    m = pattern.match(f.name)
    if not m:
        continue

    date_str = m.group(1)
    doc_type = m.group(2)
    doc_no = int(m.group(3))
    category = m.group(4)
    title = m.group(5)
    ext = m.group(6)

    if doc_no > max_no:
        max_no = doc_no

    # .md ファイルのみ概要を抽出
    summary = ""
    if ext == "md":
        try:
            content = f.read_text(encoding='utf-8')
            # "## 概要" セクションから抽出（"## 1. 概要" のような節番号付きも拾う）
            overview_match = re.search(
                r'##\s*(?:\d+[.．]\s*)?概要\s*\n\s*\n(.+?)(?:\n\n|\n##)',
                content, re.DOTALL)
            if overview_match:
                summary = overview_match.group(1).strip()[:200]
        except Exception:
            pass

    documents.append({
        "no": doc_no,
        "date": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}",
        "type": doc_type,
        "category": category,
        "title": title,
        "filename": f.name,
        "extension": ext,
        "summary": summary
    })

# next_no は現在の最大値 + 1 か、既存の next_no の大きい方
next_no = max(max_no + 1, current_next_no)

result = {
    "next_no": next_no,
    "total": len(documents),
    "generated_at": __import__('datetime').datetime.now().isoformat(),
    "documents": sorted(documents, key=lambda d: (-d["no"], d["filename"]))
}

output_path.parent.mkdir(parents=True, exist_ok=True)
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"docs.json updated: {len(documents)} documents, next_no={next_no}")
PYTHON_SCRIPT
