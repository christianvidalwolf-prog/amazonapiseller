#!/usr/bin/env python3
"""Segunda pasada: diferenciar hijos con item_name identico (gated EAN same title).

- Solo SKUs activos de catalogo_completo.csv.
- Detecta duplicados por titulo identico tras la 1a pasada.
- Sufijo desde atributos vivos distintos entre hermanos:
  color_name / size_name / model_number / style_keyword1.
- Default dry-run -> dup_plan.json ; --apply parchea.
Excluye amzn.gr* (parents sin item_name controlado).
"""
import json
import sys
import time
from typing import Any, Dict, List, Optional

import re
from collections import defaultdict

from fix_titles import (
    MAX_BYTES,
    get_listing,
    live_title,
    load_candidates,
    patch_title,
    log,
)

DUP_FILE = "dup_plan.json"
ATTR_KEYS = ["color_name", "size_name", "model_number", "style_keyword1"]


def attr_first(attrs: Dict[str, Any], key: str) -> str:
    v = attrs.get(key) or []
    if not v:
        return ""
    first = v[0]
    val = first.get("value") if isinstance(first, dict) else first
    return str(val).strip() if val else ""


def pick_suffix(group: List[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """Para cada hijo, un valor distinto a nivel de grupo por el que cancelar."""
    for key in ATTR_KEYS:
        vals = [it["attrs"].get(key, "") for it in group]
        if not any(vals):
            continue
        if len(set(vals)) == len(vals) and all(vals):
            return {it["sku"]: it["attrs"][key] for it in group}
    # mismo color/talla en todos: tratar con token de modelo unico
    return None


def main():
    apply_mode = "--apply" in sys.argv
    candidates = load_candidates(False)
    log(f"Candidatos: {len(candidates)}")

    items: List[Dict[str, Any]] = []
    for i, c in enumerate(candidates):
        sku = c["sku"]
        data = get_listing(sku)
        t = None
        attrs2: Dict[str, str] = {}
        if data:
            t = (live_title(data) or "").strip() or None
            attrs = data.get("attributes", {})
            for k in ATTR_KEYS:
                attrs2[k] = attr_first(attrs, k)
            if attrs2.get("model_number"):
                attrs2["model_number"] = attrs2["model_number"].split()[-1]
        items.append({
            "sku": sku,
            "title": t,
            "attrs": attrs2,
        })
        if (i + 1) % 50 == 0:
            log(f"  leidos {i+1}/{len(candidates)}")
        time.sleep(0.25)

    groups = defaultdict(list)
    for it in items:
        if it["title"]:
            groups[it["title"]].append(it)
    dup_groups = {t: g for t, g in groups.items() if len(g) > 1}
    log(f"Grupos duplicados: {len(dup_groups)} | SKUs afectados: "
        f"{sum(len(g) for g in dup_groups.values())}")

    plan: List[Dict[str, Any]] = []
    manual: List[Dict[str, Any]] = []
    for title, grp in dup_groups.items():
        suffixes = pick_suffix(grp)
        if not suffixes:
            manual.append({"title": title, "skus": [it["sku"] for it in grp]})
            continue
        for it in grp:
            suf = suffixes[it["sku"]]
            clean = re.sub(r"[-–— ]+$", "", str(suf))
            base = title if len((title + " - " + clean).encode("utf-8")) <= MAX_BYTES else title
            new_t = f"{base} - {clean}"
            if len(new_t.encode("utf-8")) > MAX_BYTES:
                manual.append({"title": title, "skus": [it["sku"]], "why": "sin_espacio"})
                continue
            plan.append({
                "sku": it["sku"],
                "old_title": title,
                "new_title": new_t,
                "suffix_attr": suf,
            })

    log(f"Plan dup: {len(plan)} parches | manual: {len(manual)}")
    with open(DUP_FILE, "w", encoding="utf-8") as f:
        json.dump({"plan": plan, "manual": manual}, f, ensure_ascii=False, indent=1)

    if apply_mode:
        ok = fails = 0
        for it in plan:
            g = get_listing(it["sku"])
            pt = ""
            if g and g.get("summaries"):
                pt = (g["summaries"][0] or {}).get("productType", "")
            try:
                patch_title(it["sku"], pt, it["new_title"])
                ok += 1
            except Exception as e:
                log(f"  FALLO {it['sku']}: {e}")
                fails += 1
            time.sleep(0.5)
        log(f"APPLY DUP: {ok} ok, {fails} fallos")


if __name__ == "__main__":
    main()
