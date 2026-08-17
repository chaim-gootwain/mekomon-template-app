#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tokenize.py — rebuild the GENERIC template from a live instance's code.

Reads the instance's real values from ENVIRONMENT VARIABLES (so CI can feed
them from the repo's Actions variables/secrets), then:

    python3 tokenize.py <path-to-live-copy>

rewrites .js/.html/.css/.json in place, replacing per-paper values with @@TOKENS@@.

Required env vars:
    PAPER_NAME, PAPER_SUB, PAPER_PHONE, PAPER_EMAIL,
    COLOR_BRAND, COLOR_DARK, COLOR_LIGHT, COLOR_GRAD, COLOR_ACCENT, COLOR_BG,
    SUPABASE_URL, SUPABASE_KEY
"""
import os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
EXTS = (".js", ".html", ".css", ".json")
SKIP_DIRS = {".git", ".github", "node_modules", "vendor", "migrations", "supabase"}
SKIP_FILES = {"app.bundle.js"}

REQUIRED = [
    "PAPER_NAME", "PAPER_SUB", "PAPER_PHONE", "PAPER_EMAIL",
    "COLOR_BRAND", "COLOR_DARK", "COLOR_LIGHT", "COLOR_GRAD",
    "COLOR_ACCENT", "COLOR_BG", "SUPABASE_URL", "SUPABASE_KEY",
]
_missing = [k for k in REQUIRED if not os.environ.get(k, "").strip()]
if _missing:
    sys.exit("tokenize.py: missing/empty required env vars: " + ", ".join(_missing))

E = {k: os.environ[k].strip() for k in REQUIRED}

# --- phone: match every reasonable formatting of the same number -------------
def _phone_rx(num):
    """Regex matching the number's digits with optional -, space or . between
    them, plus a +972 variant when the number starts with 0."""
    digits = re.sub(r"\D", "", num)
    sep = r"[-. ]?"
    alts = [sep.join(map(re.escape, digits))]
    if digits.startswith("0") and len(digits) > 1:
        alts.append(r"\+972" + sep + sep.join(map(re.escape, digits[1:])))
    return re.compile("|".join("(?:%s)" % a for a in alts))

PHONE_RX = _phone_rx(E["PAPER_PHONE"])

# order matters: sub before name (sub may contain the name), colors last
COLOR_TOKENS = [
    (E["COLOR_BRAND"],  "@@COLOR_BRAND@@"),
    (E["COLOR_LIGHT"],  "@@COLOR_LIGHT@@"),
    (E["COLOR_GRAD"],   "@@COLOR_GRAD@@"),
    (E["COLOR_BG"],     "@@COLOR_BG@@"),
    (E["COLOR_DARK"],   "@@COLOR_DARK@@"),
    (E["COLOR_ACCENT"], "@@COLOR_ACCENT@@"),
]

def process(t):
    t = t.replace(E["PAPER_SUB"], "@@PAPER_SUB@@").replace(E["PAPER_NAME"], "@@PAPER_NAME@@")
    t = t.replace(E["PAPER_EMAIL"], "@@PAPER_EMAIL@@")
    t = PHONE_RX.sub("@@PAPER_PHONE@@", t)
    t = t.replace(E["SUPABASE_URL"], "@@SUPABASE_URL@@").replace(E["SUPABASE_KEY"], "@@SUPABASE_KEY@@")
    seen = set()
    for hexv, tok in COLOR_TOKENS:
        if hexv.lower() in seen:  # two roles sharing one color: first token wins
            continue
        seen.add(hexv.lower())
        t = re.sub(re.escape(hexv), tok, t, flags=re.I)
    return t

changed = []
for dp, dns, fns in os.walk(ROOT):
    dns[:] = [d for d in dns if d not in SKIP_DIRS]
    for fn in fns:
        if fn in SKIP_FILES or not fn.endswith(EXTS):
            continue
        p = os.path.join(dp, fn)
        s = open(p, encoding="utf-8").read()
        n = process(s)
        if n != s:
            open(p, "w", encoding="utf-8").write(n)
            changed.append(os.path.relpath(p, ROOT))
print("tokenized:", *sorted(changed), sep="\n  ")
