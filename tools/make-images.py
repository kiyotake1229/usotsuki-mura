#!/usr/bin/env python3
"""アイコンと OGP 画像を元データから書き出す（嘘つき村の事件簿）。

  python3 tools/make-images.py          # 両方
  python3 tools/make-images.py icons    # アイコンだけ
  python3 tools/make-images.py ogp      # OGP 画像だけ

元データ → 出力
  icon.svg      → icon-512.png / icon-192.png / apple-touch-icon.png(180) / ios-app/assets/icon.png(1024)
  tools/ogp.html → ogp.png（1200×630）

必要なもの: Google Chrome（画面なしモードで描く）、Python 3 と Pillow（縮小・透明なしへの変換）、
書体を読むための通信（Google Fonts の Shippori Mincho B1）。
アイコンは 1024px で1回だけ描き、縮小して各サイズを作る。どの画像も透明なし（RGB）。
作業用のファイルは一時フォルダに作り、終わったら消す（このフォルダには残さない）。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import threading

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

# アイコンを描くための HTML。icon.svg をそのまま埋め込み、明朝の書体を読み終えてから見せる。
# 書体が読めなかったときは赤紫の四角を描き、下の検査で止める（違う書体のまま書き出さないため）。
ICON_PAGE = """<!doctype html><html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@800&display=block">
<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:#000}
#w{visibility:hidden}#w.ok{visibility:visible}#w svg{display:block;width:1024px;height:1024px}
#ng{display:none;position:fixed;inset:0;background:#FF00FF}</style></head><body>
<div id="w">%SVG%</div><div id="ng"></div>
<script>
document.fonts.load("800 408px 'Shippori Mincho B1'", "\\u5618").then(function () {
  if (document.fonts.check("800 408px 'Shippori Mincho B1'", "\\u5618")) document.getElementById('w').className = 'ok';
  else document.getElementById('ng').style.display = 'block';
}, function () { document.getElementById('ng').style.display = 'block'; });
</script></body></html>"""


def shoot(html_path, out_png, w, h):
    """Chrome の画面なしモードで html_path を w×h で撮る。

    環境によっては撮り終えても Chrome が終わらないので、
    「bytes written to file」が出たら（または120秒たったら）こちらで終わらせる。
    """
    prof = tempfile.mkdtemp(prefix='usotsuki-chrome-')
    proc = subprocess.Popen([
        CHROME, '--headless=new', '--mute-audio', '--hide-scrollbars',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--force-device-scale-factor=1', '--force-color-profile=srgb',
        '--user-data-dir=' + prof, '--window-size=%d,%d' % (w, h),
        '--virtual-time-budget=10000', '--screenshot=' + out_png,
        'file://' + html_path,
    ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    done = threading.Event()

    def watch():
        for line in proc.stdout:
            if b'bytes written to file' in line:
                done.set()
        done.set()
    threading.Thread(target=watch, daemon=True).start()
    try:
        done.wait(120)
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(prof, ignore_errors=True)
    if not os.path.exists(out_png):
        sys.exit('Chrome で画像を撮れませんでした: ' + html_path)
    im = Image.open(out_png).convert('RGB')
    if im.size != (w, h):
        sys.exit('撮った画像の大きさが違います: %s（期待 %dx%d）' % (im.size, w, h))
    return im


def is_magenta(px):
    r, g, b = px
    return r > 240 and g < 20 and b > 240


def icons():
    with open(os.path.join(ROOT, 'icon.svg'), encoding='utf-8') as f:
        svg = f.read()
    tmp = tempfile.mkdtemp(prefix='usotsuki-icon-')
    try:
        page = os.path.join(tmp, 'icon.html')
        with open(page, 'w', encoding='utf-8') as f:
            f.write(ICON_PAGE.replace('%SVG%', svg))
        im = shoot(page, os.path.join(tmp, 'icon-1024.png'), 1024, 1024)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 検査: 書体が読めたか（赤紫でない）、判子の朱と「嘘」の白が中央にあるか、四隅が藍か
    if is_magenta(im.getpixel((512, 512))):
        sys.exit('書体（Shippori Mincho B1）が読めませんでした。通信を確かめてやり直してください。')
    center = im.crop((312, 312, 712, 712)).getcolors(400 * 400)
    light = sum(n for n, (r, g, b) in center if r > 225 and g > 215 and b > 205)
    red = sum(n for n, (r, g, b) in center if r > 170 and g < 110 and b < 90)
    if light < 8000 or red < 30000:
        sys.exit('判子が描けていません（白 %d・朱 %d）。icon.svg を確かめてください。' % (light, red))
    for xy in ((4, 4), (1019, 4), (4, 1019), (1019, 1019)):
        r, g, b = im.getpixel(xy)
        if not (b > r and b > 50):
            sys.exit('四隅が藍になっていません: %s %s' % (xy, (r, g, b)))

    outs = [
        ('ios-app/assets/icon.png', 1024),
        ('icon-512.png', 512),
        ('icon-192.png', 192),
        ('apple-touch-icon.png', 180),
    ]
    for rel, size in outs:
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out = im if size == 1024 else im.resize((size, size), Image.LANCZOS)
        out.save(path, 'PNG', optimize=True)
        print('書き出し: %s（%dx%d、透明なし）' % (rel, size, size))


def ogp():
    page = os.path.join(ROOT, 'tools', 'ogp.html')
    tmp = tempfile.mkdtemp(prefix='usotsuki-ogp-')
    try:
        im = shoot(page, os.path.join(tmp, 'ogp.png'), 1200, 630)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if is_magenta(im.getpixel((600, 315))):
        sys.exit('書体が読めませんでした。通信を確かめてやり直してください。')
    im.save(os.path.join(ROOT, 'ogp.png'), 'PNG', optimize=True)
    print('書き出し: ogp.png（1200x630、透明なし）')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if what not in ('all', 'icons', 'ogp'):
        sys.exit('使い方: python3 tools/make-images.py [icons|ogp]')
    if not os.path.exists(CHROME):
        sys.exit('Google Chrome が見つかりません: ' + CHROME + '（環境変数 CHROME で場所を指定できます）')
    if what in ('all', 'icons'):
        icons()
    if what in ('all', 'ogp'):
        ogp()
