"""Generate static report instances from bundled OFL variable fonts; no downloads."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parents[1] / 'public' / 'fonts'
for source, name, weights in [('lexend.ttf', 'Lexend', [400, 600]), ('newsreader.ttf', 'Newsreader', [400])]:
    for weight in weights:
        font = TTFont(root / source)
        assert not font['OS/2'].fsType & 2, 'Font forbids embedding'
        axes = {axis.axisTag: axis.defaultValue for axis in font['fvar'].axes}
        axes['wght'] = weight
        static = instantiateVariableFont(font, axes, inplace=False)
        static.save(root / f'{name}-Report-{weight}.ttf')
        print(f'{name} report weight {weight}: generated')
