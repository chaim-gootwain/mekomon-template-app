#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
setup_instance.py — הקמת מופע חדש של המערכת לעיתון מסוים.
------------------------------------------------------------
ממלא את כל ה-@@TOKEN@@ בתבנית מתוך קובץ קונפיג, ומעתיק את הלוגו.

שימוש:
    python3 setup_instance.py instance.config

מריצים פעם אחת אחרי "Use this template", לפני שדוחפים ל-GitHub.
דורש Python 3 בלבד (יצירת אייקונים בגדלים שונים דורשת Pillow — אופציונלי).
"""
import os, re, sys, shutil

TOKENS = [
    "PAPER_NAME", "PAPER_SUB", "PAPER_PHONE", "PAPER_EMAIL",
    "COLOR_BRAND", "COLOR_DARK", "COLOR_LIGHT", "COLOR_GRAD",
    "COLOR_ACCENT", "COLOR_BG", "SUPABASE_URL", "SUPABASE_KEY",
]
EXTS = (".js", ".html", ".css", ".json")
SKIP_DIRS = {".git", "node_modules", "vendor", "migrations"}
SKIP_FILES = {"app.bundle.js", "setup_instance.py", "tokenize.py"}

def parse_config(path):
    cfg = {}
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            cfg[k] = v
    return cfg

def main():
    if len(sys.argv) < 2:
        print("usage: python3 setup_instance.py <config-file>"); sys.exit(1)
    cfg = parse_config(sys.argv[1])

    missing = [t for t in TOKENS if t not in cfg or cfg[t] == ""]
    if missing:
        print("⚠️  חסרים ערכים בקונפיג:", ", ".join(missing))
        print("   (המשך בכל זאת; טוקנים חסרים יישארו כמו שהם.)")

    # 1. replace tokens across all text files
    touched = 0
    for dp, dns, fns in os.walk("."):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES or not fn.endswith(EXTS):
                continue
            p = os.path.join(dp, fn)
            with open(p, encoding="utf-8") as f:
                txt = orig = f.read()
            for t in TOKENS:
                if t in cfg:
                    txt = txt.replace("@@%s@@" % t, cfg[t])
            if txt != orig:
                with open(p, "w", encoding="utf-8") as f:
                    f.write(txt)
                touched += 1
    print("✓ הוזרקו ערכים ל-%d קבצים" % touched)

    # 2. logo → img/logo.png + icons
    logo = cfg.get("LOGO", "").strip()
    if logo and os.path.exists(logo):
        os.makedirs("img", exist_ok=True)
        shutil.copyfile(logo, "img/logo.png")
        if os.path.exists("img/logo.svg"):
            os.remove("img/logo.svg")  # tokenized/old vector logo no longer valid
        _make_icons(logo, cfg.get("COLOR_BG", "#ffffff"))
        print("✓ לוגו הותקן (img/logo.png + אייקונים)")
    else:
        print("ℹ️  לא סופק LOGO תקין — דלג על הלוגו/אייקונים (החלף ידנית img/logo.png ואת icon-*.png).")

    # 3. verify no tokens remain
    leftover = []
    for dp, dns, fns in os.walk("."):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES or not fn.endswith(EXTS):
                continue
            p = os.path.join(dp, fn)
            with open(p, encoding="utf-8") as f:
                if "@@" in f.read():
                    leftover.append(os.path.relpath(p, "."))
    if leftover:
        print("⚠️  נותרו טוקנים @@ בקבצים:", ", ".join(sorted(set(leftover))))
    else:
        print("✓ לא נותרו טוקנים — המופע מוכן לדחיפה ולפריסה.")

def _make_icons(src, bg):
    """Create square PWA icons from the logo. Uses Pillow if available."""
    targets = {"icon-192.png": 192, "icon-512.png": 512,
               "icon-maskable.png": 512, "apple-touch-icon.png": 180}
    try:
        from PIL import Image
    except Exception:
        for name in targets:
            shutil.copyfile(src, name)
        print("  (Pillow לא מותקן — הועתק הלוגו כמות שהוא לאייקונים; מומלץ להחליף בגדלים מרובעים.)")
        return
    def hex2rgb(h):
        h = h.lstrip("#")
        if len(h) == 3:
            h = "".join(c*2 for c in h)
        return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
    try:
        bgc = hex2rgb(bg)
    except Exception:
        bgc = (255, 255, 255)
    im = Image.open(src).convert("RGBA")
    for name, size in targets.items():
        pad = int(size * (0.12 if "maskable" in name else 0.08))
        box = size - 2*pad
        w, h = im.size
        scale = min(box/w, box/h)
        nw, nh = max(1, int(w*scale)), max(1, int(h*scale))
        logo = im.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), bgc + (255,))
        canvas.paste(logo, ((size-nw)//2, (size-nh)//2), logo)
        canvas.convert("RGB").save(name, "PNG")

if __name__ == "__main__":
    main()
