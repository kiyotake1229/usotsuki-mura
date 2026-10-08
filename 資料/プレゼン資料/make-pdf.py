# 嘘つき村の事件簿 社内説明スライドの PDF を作る
# スライドの元データは project/（Claude の Slides で公開しているものと同じファイル）。
#   project/deck.json        … 題名・並び順・書体
#   project/slides/<id>.html … 1枚ずつのスライド（1920×1080）
# 使い方: python3 資料/プレゼン資料/make-pdf.py
#   → このフォルダに 嘘つき村の事件簿_社内説明.pdf を書き出す（Google Chrome が必要）
#   --png <フォルダ> を付けると、確認用に1枚ずつ PNG も書き出す
import json, os, subprocess, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, '嘘つき村の事件簿_社内説明.pdf')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

deck = json.load(open(os.path.join(HERE, 'project', 'deck.json'), encoding='utf-8'))
links = ''.join('<link rel="stylesheet" href="%s">' % f['href'] for f in deck['faces'].values() if 'href' in f)
# Slides の表示に近づけるための最小限の CSS（余白なし・1枚1ページ・話す台本は隠す）
BASE = '''<style>
@page { size: 1920px 1080px; margin: 0 }
html, body { margin: 0; padding: 0; background: #1B2A47 }
section { position: relative; width: 1920px; height: 1080px; overflow: hidden; box-sizing: border-box; break-after: page }
section * { margin: 0; box-sizing: border-box }
section aside { display: none }
section table { border-collapse: collapse; width: 100% }
section th, section td { padding: .35em .6em; border-bottom: 2px solid rgba(27,42,71,.15); text-align: left; vertical-align: top }
section th { font-weight: 700 }
</style>'''

def chrome(args, out):
    # Chrome は書き出したあと終わらないことがあるので、待つのは60秒まで。ファイルができていれば成功とみなす
    try:
        subprocess.run([CHROME] + args, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        pass
    if not (os.path.exists(out) and os.path.getsize(out) > 0):
        sys.exit('書き出しに失敗しました: ' + out)

def page(sections, title):
    return ('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>%s</title>%s%s</head><body>%s</body></html>'
            % (title, links, BASE, ''.join(sections)))

slides = [open(os.path.join(HERE, 'project', 'slides', i + '.html'), encoding='utf-8').read() for i in deck['order']]
if not os.path.exists(CHROME):
    sys.exit('Google Chrome が見つからないため PDF は作っていません')

tmp = tempfile.mkdtemp()
try:
    deck_html = os.path.join(tmp, 'deck.html')
    open(deck_html, 'w', encoding='utf-8').write(page(slides, deck['title']))
    if os.path.exists(PDF):
        os.remove(PDF)
    chrome(['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--mute-audio',
            '--user-data-dir=' + os.path.join(tmp, 'profile'), '--virtual-time-budget=10000',
            '--print-to-pdf=' + PDF, 'file://' + deck_html], PDF)
    print('pdf', PDF)
    if '--png' in sys.argv:
        out = sys.argv[sys.argv.index('--png') + 1]
        os.makedirs(out, exist_ok=True)
        for n, (sid, s) in enumerate(zip(deck['order'], slides), 1):
            one = os.path.join(tmp, sid + '.html')
            open(one, 'w', encoding='utf-8').write(page([s], sid))
            png = os.path.join(out, '%02d-%s.png' % (n, sid))
            chrome(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
                    '--user-data-dir=' + os.path.join(tmp, 'profile-' + sid), '--window-size=1920,1080',
                    '--virtual-time-budget=10000', '--screenshot=' + png, 'file://' + one], png)
            print('png', png)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
