#!/usr/bin/env python3
"""
Correccion deTitulos de listings (marketplace Espana).

Fuentes:
  problems_audit.json  -> SKU_EN_TITULO, LARGO_200B, FIN_RARO, SPAM_KEYWORDS
  issues_audit.json    -> TODO_MAYUSCULAS, MUCHO_MAYUSCULAS
  catalogo_completo.csv-> estado Active/Inactive/Incomplete

Modo:
  (default) dry-run: lee el titulo LIVE via Listings Items API, verifica que el
            problema sigue existiendo, genera el titulo corregido y escribe title_plan.json
  --apply:  ademas parchea item_name via PATCH.

Solo toca SKUs Active salvo --include-inactive. Nunca inventa texto nuevo:
recorta en frontera de palabra, elimina el SKU y limpia separadores.
"""

import os
import re
import csv
import sys
import json
import time
import unicodedata
from typing import Optional, Dict, Any, List

import requests

from auth import get_access_token, get_base_url

SELLER_ID = os.getenv("SP_API_SELLER_ID", "A3RY0L9OY3TPHI").strip()
ES_MARKETPLACE_ID = "A1RKKUPIHCS9HS"
ES_LOCALE = "es_ES"

MAX_BYTES = 200
BASE_URL = get_base_url()

CATALOG = "catalogo_completo.csv"
PROBLEMS = "problems_audit.json"
ISSUES = "issues_audit.json"
PLAN_FILE = "title_plan.json"

# Etiquetas que corregimos en modo principal
MAIN_TAGS = ("LARGO_200B", "SKU_EN_TITULO", "FIN_RARO")
CAPS_TAGS = ("TODO_MAYUSCULAS", "MUCHO_MAYUSCULAS")

SPAM_TAG = "SPAM_KEYWORDS"

# Palabras/acronimos que se mantienen tal cual en titularizacion
KEEP_UPPER = {
    "LED", "USB", "XL", "XXL", "XXS", "AC", "DC", "TV", "PC", "HD",
    "3D", "LED", "RGB", "UV", "IQ", "AI", "DIY", "GPS", "WIFI", "INC",
}
# Palabras funcionales que van en minuscula dentro del titulo
LOWER_WORDS = {
    "de", "del", "la", "el", "los", "las", "y", "o", "en", "con",
    "para", "una", "un", "al", "a", "e", "u", "por", "sin", "sobre",
}
MOJIBAKE = {"‡": "á", "†": "ñ"}


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- helpers

def norm_text(s: str) -> str:
    for k, v in MOJIBAKE.items():
        s = s.replace(k, v)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def strip_sep_edges(s: str) -> str:
    s = re.sub(r"^[\s\-–:|,\.]+", "", s)
    s = re.sub(r"[\s\-–:|,]+$", "", s)
    return s


def collapse_seps(s: str) -> str:
    """Colapsa separadores huérfanos: ' - - ', ' - ,', '( ', ') (', dobles espacios."""
    s = re.sub(r"\s*[-–]\s*[-–]+", " - ", s)
    s = re.sub(r"\s*[-–]\s*,\s*", ", ", s)
    s = re.sub(r",\s*[-–]\s*", " - ", s)
    s = re.sub(r"\(\s+\)", "", s)
    s = re.sub(r"\(\s+([^)]+)\s+\)", r"(\1)", s)
    s = re.sub(r"\s+\)", ")", s)
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"^[\s\-–:|,]+", "", s)
    s = re.sub(r"[\s\-–:|,]+$", "", s)
    return s


def remove_sku_from_title(title: str, sku: str) -> str:
    out = re.sub(rf"(?<![\w-]){re.escape(sku)}(?![\w-])\s*[-–:]?\s*", "", title, flags=re.IGNORECASE)
    return collapse_seps(out)


def _drop_unbalanced_paren(s: str) -> str:
    if s.count("(") > s.count(")"):
        s = s[: s.rfind("(")]
    if s.count("[") > s.count("]"):
        s = s[: s.rfind("[")]
    return s


def trunc_bytes(title: str, maxb: int = MAX_BYTES) -> str:
    if len(title.encode("utf-8")) <= maxb:
        return title
    # 1) corte en el separador grande mas largo que quepa
    best = None
    for sep in (" - ", ", "):
        for pos in [m.start() for m in re.finditer(re.escape(sep), title)]:
            cand = strip_sep_edges(title[:pos])
            nb = len(cand.encode("utf-8")) if cand else 0
            if nb and nb <= maxb and (best is None or nb > len(best.encode("utf-8"))):
                best = cand
    if best:
        return collapse_seps(best)
    # 2) corte duro en frontera de palabra
    s = title.encode("utf-8")[:maxb].decode("utf-8", "ignore")
    s = s[: s.rfind(" ")] if " " in s else s
    return collapse_seps(_drop_unbalanced_paren(s))


def title_word(w: str) -> str:
    if len(w) <= 3 or not w.isalpha():
        return w
    return w[0].upper() + w[1:].lower()


def fix_caps(title: str) -> str:
    """TODO/MUCHO MAYUSCULAS -> Capitalizacion natural, preservando simbolos."""
    keep_upper_l = {k.lower() for k in KEEP_UPPER}

    def word(w: str) -> str:
        wl = w.lower()
        if wl in LOWER_WORDS:
            return wl
        if wl in keep_upper_l:
            return w
        if len(w) <= 3:
            return w  # siglas/unidades cortas (LED ya cubierto arriba)
        if w.isupper():
            return wl.capitalize()
        return w

    def repl(m):
        return word(m.group(0))

    out = re.sub(r"[A-Za-zÀ-ÿ]{2,}", repl, title)
    if out[:1].isalpha() and out[:1].islower():
        out = out[:1].upper() + out[1:]
    return out


def clean_fin_raro(title: str) -> Optional[str]:
    """Termina en separador suelto/generated cut: recorta la cola suelta."""
    t = collapse_seps(title)
    # colas de ruido tipo "-6-", "-6", "(-6-", "&"
    t = re.sub(r"\s*[-–]\s*\d{1,4}\s*[-–]?\s*$", "", t)
    t = re.sub(r"\s*[-–]?\s*[&@]\s*[-–]?\s*$", "", t)
    t = collapse_seps(t)
    if t != title:
        return t
    if re.search(r"[-–:|,;\(\[\{/]\s*$", title):
        return collapse_seps(title)
    # medias palabras no se reescriben: dejarla y marcarla
    return None


def is_all_caps(title: str) -> bool:
    letters = [c for c in title if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.85


def heavy_caps(title: str) -> bool:
    words = [w for w in re.findall(r"[A-Za-zÀ-ÿ]+$", title)]
    up = [w for w in words if w.isupper() and len(w) > 3]
    letters = [c for c in title if c.isalpha()]
    if not letters:
        return False
    return len(up) >= 3 or (sum(c.isupper() for c in letters) / len(letters)) > 0.5


# ---------------------------------------------------------------- API

def get_listing(sku: str) -> Optional[Dict[str, Any]]:
    token = get_access_token()
    url = f"{BASE_URL}/listings/2021-08-01/items/{SELLER_ID}/{sku}"
    url += f"?marketplaceIds={ES_MARKETPLACE_ID}&includedData=summaries,attributes"
    for attempt in range(3):
        try:
            res = requests.get(url, headers={"x-amz-access-token": token}, timeout=20)
            if res.status_code == 200:
                return res.json()
            if res.status_code == 429:
                time.sleep(2 * (attempt + 1))
                token = get_access_token()
                continue
            return None
        except Exception:
            time.sleep(1)
    return None


def live_title(data: Dict[str, Any]) -> Optional[str]:
    for a in (data.get("attributes", {}) or {}).get("item_name", []) or []:
        if isinstance(a, dict) and a.get("value"):
            if a.get("marketplace_id") in (None, ES_MARKETPLACE_ID):
                return a["value"]
    return None


def live_status(data: Dict[str, Any]) -> str:
    sums = data.get("summaries", [])
    return (sums[0].get("status") if sums else "") or ""


def patch_title(sku: str, product_type: str, new_title: str) -> Dict[str, Any]:
    token = get_access_token()
    url = f"{BASE_URL}/listings/2021-08-01/items/{SELLER_ID}/{sku}"
    url += f"?marketplaceIds={ES_MARKETPLACE_ID}&issueLocale={ES_LOCALE}"
    body = {
        "productType": product_type,
        "patches": [{
            "op": "replace",
            "path": "/attributes/item_name",
            "value": [{
                "value": new_title,
                "language_tag": ES_LOCALE,
                "marketplace_id": ES_MARKETPLACE_ID,
            }],
        }],
    }
    res = requests.patch(url, headers={
        "x-amz-access-token": token,
        "Content-Type": "application/json",
    }, json=body, timeout=30)
    try:
        return res.json()
    except Exception:
        return {"http_status": res.status_code}


# ---------------------------------------------------------------- main

def load_statuses() -> Dict[str, str]:
    out = {}
    with open(CATALOG, encoding="utf-8-sig", errors="replace") as f:
        for row in csv.DictReader(f, delimiter=";"):
            sku = (row.get("seller-sku") or "").strip()
            st = (row.get("status") or "").strip()
            if sku:
                out[sku] = st
    return out


def load_candidates(include_inactive: bool):
    statuses = load_statuses()
    rows = {}
    for path, keys in ((PROBLEMS, ("tags",)), (ISSUES, ("tags",))):
        with open(path, encoding="utf-8") as f:
            for r in json.load(f):
                sku = r["sku"].strip()
                tags = set(r.get("tags", []))
                main = tags & set(MAIN_TAGS)
                caps = tags & set(CAPS_TAGS)
                if tags & {SPAM_TAG}:
                    main = main | {"SPAM"}
                    rows.setdefault(sku, {"tags": set(), "title": r.get("title", "")})
                    rows[sku]["tags"].add("SPAM")
                    continue
                if main:
                    rows.setdefault(sku, {"tags": set(), "title": r.get("title", "")})
                    rows[sku]["tags"] |= main
                if caps:
                    rows.setdefault(sku, {"tags": set(), "title": r.get("title", "")})
                    rows[sku]["tags"] |= caps
    candidates = []
    for sku, info in sorted(rows.items()):
        st = statuses.get(sku, "?")
        active = st == "Active"
        if not active and not include_inactive:
            continue
        candidates.append({"sku": sku, "status": st, "tags": sorted(info["tags"]),
                           "csv_title": info["title"]})
    return candidates


def plan_fix(sku: str, live: str, tags: List[str]) -> Optional[str]:
    t = norm_text(live)
    if "SKU_EN_TITULO" in tags:
        t = remove_sku_from_title(t, sku)
    if "SPAM" in tags:
        pass  # no se modifica automaticamente
    fixed_raro = False
    if "FIN_RARO" in tags:
        nt = clean_fin_raro(t)
        if nt is not None:
            t = nt
            fixed_raro = True
    if "TODO_MAYUSCULAS" in tags or "MUCHO_MAYUSCULAS" in tags or is_all_caps(t) or heavy_caps(t):
        if "TODO_MAYUSCULAS" in tags or is_all_caps(t):
            t = fix_caps(t)
        elif heavy_caps(t):
            t2 = fix_caps(t)
            if t2 != t:
                t = t2
    if "LARGO_200B" in tags or len(t.encode("utf-8")) > MAX_BYTES:
        t = trunc_bytes(t)
    if fixed_raro is False and "FIN_RARO" in tags and re.search(r"[-–:|,;\(\[\{/]\s*$", t):
        t = collapse_seps(t)
    t = collapse_seps(t)
    if t == live or not t:
        return None
    return t


def main():
    include_inactive = "--include-inactive" in sys.argv
    apply_mode = "--apply" in sys.argv
    limit = 0
    for i, a in enumerate(sys.argv):
        if a == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    candidates = load_candidates(include_inactive)
    log(f"Candidatos: {len(candidates)}")
    plan_items, spam_items, skipped = [], [], []

    for i, c in enumerate(candidates):
        sku = c["sku"]
        if limit and i >= limit:
            break
        data = get_listing(sku)
        if not data:
            skipped.append({"sku": sku, "why": "sin_listing_api"})
            continue
        live = live_title(data)
        if not live:
            skipped.append({"sku": sku, "why": "sin_item_name"})
            continue
        if "SPAM" in c["tags"]:
            spam_items.append({"sku": sku, "title": live, "tags": c["tags"]})
            continue
        new = plan_fix(sku, live, c["tags"])
        if new is None:
            skipped.append({"sku": sku, "why": "sin_cambio_requerido", "tags": c["tags"]})
            continue
        if len(new.encode("utf-8")) > MAX_BYTES:
            new = trunc_bytes(new)
        plan_items.append({
            "sku": sku,
            "status": c["status"],
            "tags": c["tags"],
            "product_type": (data.get("summaries") or [{}])[0].get("productType", ""),
            "live_title": live,
            "new_title": new,
            "bytes_old": len(live.encode("utf-8")),
            "bytes_new": len(new.encode("utf-8")),
            "changed": new != live,
        })
        if (i + 1) % 25 == 0:
            log(f"  leidos {i+1}/{len(candidates)}")
        time.sleep(0.25)

    log(f"Plan: {len(plan_items)} parches | {len(spam_items)} spam (manual) | {len(skipped)} sin cambio")
    with open(PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump({"plan": plan_items, "spam": spam_items, "skipped": skipped}, f,
                  ensure_ascii=False, indent=1)

    if apply_mode:
        ok = fails = 0
        for it in plan_items:
            if not it["changed"]:
                ok += 1
                continue
            resp = patch_title(it["sku"], it["product_type"], it["new_title"])
            st = resp.get("status", "")
            if st in ("ACCEPTED", "SUCCEEDED") or not resp.get("issues") and resp.get("status") != "FAILED":
                ok += 1
            else:
                fails += 1
                log(f"  ❌ {it['sku']}: {json.dumps(resp)[:300]}")
            time.sleep(0.5)
        log(f"APPLY: {ok} ok, {fails} fallos")
    else:
        for it in plan_items[:10]:
            print(f"\nSKU {it['sku']} [{','.join(it['tags'])}] {it['bytes_old']}→{it['bytes_new']}b")
            print(f"  VIEJO: {it['live_title']}")
            print(f"  NUEVO: {it['new_title']}")


if __name__ == "__main__":
    main()
