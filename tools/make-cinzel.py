"""Dev only (not shipped): build labels/lib/cinzel/ from google/fonts, or validate it.

    uv run --with fonttools --with brotli python tools/make-cinzel.py          # build
    uv run --with fonttools --with brotli python tools/make-cinzel.py --check  # validate, no network

Build: fetch the Cinzel variable font + OFL.txt + FONTLOG.txt with gh, instance wght 700,
subset to Latin, write woff2. The licence files are copied byte for byte.
"""
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent / "labels" / "lib" / "cinzel"
WOFF2 = OUT / "cinzel-bold-latin.woff2"
REMOTE = "repos/google/fonts/contents/ofl/cinzel/"
MAX_BYTES = 30_000

UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x180))
    + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x00B7, 0x2122]
)
# Spot checks on top of UNICODES: the glyphs real set names need.
MUST_HAVE = "ÆæéÉ×·’&:'(),-./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def fetch(name: str, dest: Path) -> None:
    data = subprocess.run(
        ["gh", "api", "-H", "Accept: application/vnd.github.raw", REMOTE + name],
        check=True, capture_output=True,
    ).stdout
    dest.write_bytes(data)


def build() -> None:
    from fontTools.varLib import instancer

    tmp = Path(tempfile.mkdtemp(prefix="cinzel-"))
    try:
        src = tmp / "Cinzel[wght].ttf"
        fetch("Cinzel%5Bwght%5D.ttf", src)
        fetch("OFL.txt", tmp / "OFL.txt")
        fetch("FONTLOG.txt", tmp / "FONTLOG.txt")
        print("source sha256", hashlib.sha256(src.read_bytes()).hexdigest())

        static = instancer.instantiateVariableFont(TTFont(src), {"wght": 700})
        static.save(tmp / "Cinzel-Bold-static.ttf")

        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["kern", "liga"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        font = TTFont(tmp / "Cinzel-Bold-static.ttf")
        subsetter = subset.Subsetter(opts)
        subsetter.populate(unicodes=UNICODES)
        subsetter.subset(font)
        font.flavor = "woff2"

        OUT.mkdir(parents=True, exist_ok=True)
        font.save(WOFF2)
        shutil.copyfile(tmp / "OFL.txt", OUT / "OFL.txt")
        shutil.copyfile(tmp / "FONTLOG.txt", OUT / "FONTLOG.txt")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fail(msg: str) -> None:
    print(f"CHECK FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def check() -> None:
    for f in (WOFF2, OUT / "OFL.txt", OUT / "FONTLOG.txt"):
        if not f.is_file():
            fail(f"missing {f}")
    size = WOFF2.stat().st_size
    if size >= MAX_BYTES:
        fail(f"woff2 is {size} bytes, limit {MAX_BYTES}")
    font = TTFont(WOFF2)
    cmap = font.getBestCmap()
    gaps = [f"U+{cp:04X}" for cp in UNICODES if cp not in cmap]
    # The Latin-1 / Latin Extended-A ranges may have holes upstream; the spot checks must not.
    gaps_must = [c for c in MUST_HAVE if ord(c) not in cmap]
    if gaps_must:
        fail(f"cmap lacks {gaps_must}")
    required = [*range(0x20, 0x7F), *range(0xA0, 0x100), 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0xB7, 0x2122]
    gaps_req = [f"U+{cp:04X}" for cp in required if cp not in cmap]
    if gaps_req:
        fail(f"cmap lacks {gaps_req}")
    if gaps:
        print(f"note: upstream font has no glyph for {len(gaps)} listed code points: {' '.join(gaps)}")
    if "fvar" in font:
        fail("fvar table present, not a static instance")
    if font["OS/2"].usWeightClass != 700:
        fail(f"usWeightClass is {font['OS/2'].usWeightClass}, expected 700")
    ofl = (OUT / "OFL.txt").read_text(encoding="utf-8")
    if "SIL OPEN FONT LICENSE" not in ofl:
        fail("OFL.txt lacks 'SIL OPEN FONT LICENSE'")
    if "Copyright 2020 The Cinzel Project Authors" not in ofl:
        fail("OFL.txt lacks the Cinzel copyright line")
    copyright_line = next(l for l in ofl.splitlines() if "Copyright 2020 The Cinzel Project Authors" in l)
    if "Reserved Font Name" in copyright_line:
        fail("copyright line declares a Reserved Font Name")
    if not (OUT / "FONTLOG.txt").read_text(encoding="utf-8").strip():
        fail("FONTLOG.txt is empty")
    print("CHECK OK")


if __name__ == "__main__":
    if "--check" not in sys.argv[1:]:
        build()
    check()
