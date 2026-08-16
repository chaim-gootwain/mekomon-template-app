#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tokenize.py — rebuild the GENERIC template from a live instance's code.
Set the *_SRC values below to the live instance you are refreshing from,
then run:  python3 tokenize.py <path-to-live-copy>
It rewrites .js/.html/.css/.json in place, replacing per-paper values with @@TOKENS@@."""
import os, re, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
EXTS=(".js",".html",".css",".json"); SKIP_DIRS={".git","node_modules","vendor","migrations","supabase"}; SKIP_FILES={"app.bundle.js"}
# ---- reference live values (edit to match the instance you refresh from) ----
PAPER_NAME="אמצעש"; PAPER_SUB="לדעת לקנות להרגיש הבית"
PHONE="053-412-0800"; PHONE_RAW="0534120800"; EMAIL="emtzash.em@gmail.com"
SB_URL="https://lnpvebpqtogwegvudvou.supabase.co"; SB_KEY="sb_publishable_1gTo3MNuXhmxiv0DvycNAA_XDxep1zp"
def process(t):
    t=t.replace(PAPER_SUB,"@@PAPER_SUB@@").replace(PAPER_NAME,"@@PAPER_NAME@@")
    t=t.replace(EMAIL,"@@PAPER_EMAIL@@").replace(PHONE,"@@PAPER_PHONE@@").replace(PHONE_RAW,"@@PAPER_PHONE@@")
    t=t.replace(SB_URL,"@@SUPABASE_URL@@").replace(SB_KEY,"@@SUPABASE_KEY@@")
    for hexv,tok in [("#F26622","@@COLOR_BRAND@@"),("#FDECE0","@@COLOR_LIGHT@@"),
                     ("#C24E12","@@COLOR_GRAD@@"),("#F6F5F4","@@COLOR_BG@@"),("#333333","@@COLOR_DARK@@")]:
        t=re.sub(hexv,tok,t,flags=re.I)
    return t
changed=[]
for dp,dns,fns in os.walk(ROOT):
    dns[:]=[d for d in dns if d not in SKIP_DIRS]
    for fn in fns:
        if fn in SKIP_FILES or not fn.endswith(EXTS): continue
        p=os.path.join(dp,fn); s=open(p,encoding="utf-8").read(); n=process(s)
        if n!=s: open(p,"w",encoding="utf-8").write(n); changed.append(os.path.relpath(p,ROOT))
print("tokenized:", *sorted(changed), sep="\n  ")
