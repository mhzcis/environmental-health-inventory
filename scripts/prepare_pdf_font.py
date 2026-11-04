"""Add cmap aliases for isolated Arabic forms to the bundled OFL Cairo font.
No outlines change and no external font is downloaded. Idempotent; QA/build maintenance only.
Requires the existing local fontTools runtime, not a browser dependency.
"""
from pathlib import Path
import unicodedata
from fontTools.ttLib import TTFont
path=Path(__file__).resolve().parents[1]/'public/Cairo-Regular.ttf'
font=TTFont(path);cmap=font.getBestCmap();added=0
for code in range(0xfb50,0xff00):
    parts=unicodedata.decomposition(chr(code)).split()
    if len(parts)==2 and parts[0]=='<isolated>' and code not in cmap and int(parts[1],16) in cmap:
        for table in font['cmap'].tables:
            if table.isUnicode():table.cmap[code]=cmap[int(parts[1],16)]
        added+=1
if added:font.save(path)
print(f'Added {added} isolated-form cmap aliases; glyph outlines and copyright retained.')
