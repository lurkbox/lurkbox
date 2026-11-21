#!/usr/bin/env python3
"""Build Lurkbox's Steam artwork and app icons (art direction B, "Late-night couch").

Outputs:
  assets/steam/capsule.png        600x900   portrait library capsule   -> grid/<appid>p.png
  assets/steam/wide.png           920x430   wide capsule / header      -> grid/<appid>.png
  assets/steam/hero.png           3840x1240 library hero, no text      -> grid/<appid>_hero.png
  assets/steam/logo.png           1600x~460 transparent logo           -> grid/<appid>_logo.png
  assets/steam/icon.png           256x256   shortcut icon              -> shortcuts.vdf "icon"
  assets/icons/<n>x<n>.png        app icons (electron-builder linux icon dir)
  assets/src/*.svg                the SVG sources

The wordmark is converted to outlines from Bricolage Grotesque ExtraBold (SIL OFL 1.1). The script only needs the font when
regenerating; pass --font <BricolageGrotesque[opsz,wdth,wght].ttf>. Otherwise it reuses assets/src/wordmark.json.
Needs rsvg-convert to rasterise.
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
WORD = 'Lurkbox'

# Palette (direction B)
BG_TOP, BG_BOT = '#123236', '#081719'
SIL = '#06120F'          # silhouette
CREAM = '#FFE3CC'        # wordmark

def wordmark_from_font(font_path):
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    f = TTFont(font_path)
    f = instantiateVariableFont(f, {'wght': 800, 'opsz': 96, 'wdth': 100})
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f['hmtx']
    upm = f['head'].unitsPerEm
    kern = {}
    try:  # simple pair kerning from GPOS PairPos format 1 (good enough for one word)
        for lookup in f['GPOS'].table.LookupList.Lookup:
            for st in lookup.SubTable:
                st = getattr(st, 'ExtSubTable', st)
                if getattr(st, 'Format', None) == 1 and hasattr(st, 'PairSet'):
                    for i, first in enumerate(st.Coverage.glyphs):
                        for pvr in st.PairSet[i].PairValueRecord:
                            v = getattr(pvr.Value1, 'XAdvance', 0) if pvr.Value1 else 0
                            if v: kern.setdefault((first, pvr.SecondGlyph), v)
    except Exception:
        pass
    pen = SVGPathPen(gs)
    x, prev, track = 0, None, -0.01 * upm
    for ch in WORD:
        g = cmap[ord(ch)]
        if prev: x += kern.get((prev, g), 0)
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        x += hmtx[g][0] + track
        prev = g
    from fontTools.pens.boundsPen import BoundsPen
    bp = BoundsPen(gs)
    x = 0; prev = None
    for ch in WORD:
        g = cmap[ord(ch)]
        if prev: x += kern.get((prev, g), 0)
        gs[g].draw(TransformPen(bp, (1, 0, 0, -1, x, 0)))
        x += hmtx[g][0] + track
        prev = g
    xmin, ymin, xmax, ymax = bp.bounds
    return {'d': pen.getCommands(), 'bbox': [xmin, ymin, xmax, ymax], 'upm': upm}

def word(wm, x, y, width, fill=CREAM, extra=''):
    """Place the wordmark so its bbox's left/top is at (x, y), scaled to `width`."""
    xmin, ymin, xmax, ymax = wm['bbox']
    s = width / (xmax - xmin)
    return (f'<path d="{wm["d"]}" fill="{fill}" {extra} '
            f'transform="translate({x - xmin * s:.2f} {y - ymin * s:.2f}) scale({s:.5f})"/>')

def word_h(wm, width):
    xmin, ymin, xmax, ymax = wm['bbox']
    return (ymax - ymin) * width / (xmax - xmin)

DEFS = f'''<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG_BOT}"/></linearGradient>
  <radialGradient id="screen" cx=".5" cy=".45" r=".7"><stop offset="0" stop-color="#FFD3A8"/><stop offset=".6" stop-color="#FF8A66"/><stop offset="1" stop-color="#E0504A"/></radialGradient>
  <radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FF8A66" stop-opacity=".45"/><stop offset="1" stop-color="#FF8A66" stop-opacity="0"/></radialGradient>
  <radialGradient id="spill" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FF8A66" stop-opacity=".22"/><stop offset="1" stop-color="#FF8A66" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-10%" y="-20%" width="120%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity=".55"/></filter>
</defs>'''

def mascot(halo=True):
    """The glowing TV + couch lurker, in a 256x256 box."""
    return ''.join([
        '<circle cx="128" cy="108" r="120" fill="url(#halo)"/>' if halo else '',
        '<rect x="40" y="46" width="176" height="122" rx="18" fill="url(#screen)"/>',
        f'<circle cx="128" cy="170" r="15" fill="{SIL}"/>',
        f'<rect x="60" y="180" width="136" height="32" rx="12" fill="{SIL}"/>',
        f'<rect x="44" y="194" width="28" height="36" rx="10" fill="{SIL}"/>',
        f'<rect x="184" y="194" width="28" height="36" rx="10" fill="{SIL}"/>',
        f'<rect x="62" y="206" width="132" height="22" rx="6" fill="{SIL}"/>',
    ])

def place(inner, x, y, size):
    return f'<g transform="translate({x} {y}) scale({size / 256:.5f})">{inner}</g>'

def svg(w, h, body, bg=True):
    back = f'<rect width="{w}" height="{h}" fill="url(#bg)"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{DEFS}{back}{body}</svg>\n'

def icon_svg():
    # Rounded square with a transparent margin, like a desktop app icon.
    body = (f'<clipPath id="r"><rect x="8" y="8" width="240" height="240" rx="54"/></clipPath>'
            f'<g clip-path="url(#r)"><rect width="256" height="256" fill="url(#bg)"/>'
            f'{place(mascot(), 14, 18, 228)}</g>')
    return svg(256, 256, body, bg=False)

def wide_svg(wm):
    ww = 470
    return svg(920, 430, place(mascot(), 24, 40, 350) + word(wm, 398, 215 - word_h(wm, ww) / 2, ww))

def capsule_svg(wm):
    ww = 470
    return svg(600, 900, place(mascot(), 22, 70, 556) + word(wm, 65, 690, ww))

def hero_svg():
    w, h = 3840, 1240
    floor = 1010
    body = [
        f'<rect y="{floor}" width="{w}" height="{h - floor}" fill="{SIL}" opacity=".55"/>',
        f'<ellipse cx="2510" cy="{floor + 40}" rx="1100" ry="180" fill="url(#spill)"/>',
        place(mascot(), 1940, 30, 1140),
        # floor lamp (left) and a plant (right), as silhouettes
        f'<rect x="1730" y="420" width="14" height="{floor - 420}" fill="{SIL}"/>',
        f'<path d="M1680 420 L1794 420 L1772 330 L1702 330 Z" fill="{SIL}"/>',
        f'<rect x="1690" y="{floor - 14}" width="94" height="14" rx="7" fill="{SIL}"/>',
        f'<path d="M3250 {floor} L3230 {floor - 120} L3330 {floor - 120} L3310 {floor} Z" fill="{SIL}"/>',
        f'<path d="M3280 {floor - 120} C3200 {floor - 300} 3150 {floor - 360} 3170 {floor - 420} C3240 {floor - 360} 3270 {floor - 260} 3280 {floor - 120} Z" fill="{SIL}"/>',
        f'<path d="M3280 {floor - 120} C3330 {floor - 320} 3390 {floor - 380} 3420 {floor - 400} C3410 {floor - 320} 3340 {floor - 220} 3280 {floor - 120} Z" fill="{SIL}"/>',
        f'<path d="M3280 {floor - 120} C3270 {floor - 330} 3285 {floor - 450} 3300 {floor - 500} C3320 {floor - 420} 3300 {floor - 260} 3280 {floor - 120} Z" fill="{SIL}"/>',
    ]
    return svg(w, h, ''.join(body))

def logo_svg(wm):
    # Wordmark only: the hero already carries the couch scene, and the dark silhouette would vanish on it.
    ww, pad = 1280, 40
    wh = word_h(wm, ww)
    w, h = int(ww + 2 * pad), int(wh + 2 * pad)
    body = f'<g filter="url(#shadow)">{word(wm, pad, pad, ww)}</g>'
    return svg(w, h, body, bg=False)

def render(src, out, w=None):
    cmd = ['rsvg-convert', src, '-o', out] + (['-w', str(w), '-h', str(w)] if w else [])
    subprocess.run(cmd, check=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--font', help='Bricolage Grotesque variable TTF, to regenerate assets/src/wordmark.json')
    a = ap.parse_args()
    wj = os.path.join(HERE, 'wordmark.json')
    if a.font:
        json.dump(wordmark_from_font(a.font), open(wj, 'w'))
    wm = json.load(open(wj))
    os.makedirs(os.path.join(ASSETS, 'steam'), exist_ok=True)
    os.makedirs(os.path.join(ASSETS, 'icons'), exist_ok=True)
    srcs = {'icon': icon_svg(), 'wide': wide_svg(wm), 'capsule': capsule_svg(wm), 'hero': hero_svg(), 'logo': logo_svg(wm)}
    for name, s in srcs.items():
        p = os.path.join(HERE, f'{name}.svg')
        open(p, 'w').write(s)
        render(p, os.path.join(ASSETS, 'steam', f'{name}.png'))
    for n in (512, 256, 128, 64, 48, 32, 16):
        render(os.path.join(HERE, 'icon.svg'), os.path.join(ASSETS, 'icons', f'{n}x{n}.png'), n)
    print('ok')

if __name__ == '__main__':
    sys.exit(main())
