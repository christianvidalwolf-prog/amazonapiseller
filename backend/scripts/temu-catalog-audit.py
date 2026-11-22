#!/usr/bin/env python3
"""Read-only Temu ES listing audit; deliberately leaves all products unchanged."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

from lib.temu_client import TemuApiError, TemuClient, TemuCredentials


STATUSES = (1, 2, 4, 5, 6)
DETAIL_STATUSES = (2, 4, 5, 6)


def _result(payload: dict[str, Any]) -> dict[str, Any]:
    return payload.get("result") or {}


def _list_status(client: TemuClient, status: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        result = _result(client.list_goods(status, page_no=page, page_size=100))
        batch = result.get("goodsList") or []
        items.extend(batch)
        total = int(result.get("total", len(items)))
        if not batch or len(items) >= total:
            return items
        page += 1


def _has_code(value: Any, code: str) -> bool:
    if isinstance(value, dict):
        return any(_has_code(v, code) for v in value.values())
    if isinstance(value, list):
        return any(_has_code(v, code) for v in value)
    return str(value) == code


def _product_summary(status: int, listing: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    goods = _result(detail)
    listing_skus = listing.get("skuInfoList") or []
    listing_by_id = {str(s.get("skuId")): s for s in listing_skus if s.get("skuId") is not None}
    detail_skus = goods.get("skuList") or []
    skus = []
    seen_ids: set[str] = set()
    for sku in detail_skus:
        sku_id = str(sku.get("skuId") or "")
        listing_sku = listing_by_id.get(sku_id, {})
        merged = {**listing_sku, **sku}
        # The current list response is authoritative for inventory; detail responses
        # may omit quantity or expose a stale product-level fallback.
        merged["quantity"] = listing_sku.get("quantity", listing_sku.get("stock", sku.get("quantity")))
        skus.append(merged)
        if sku_id:
            seen_ids.add(sku_id)
    skus.extend(sku for sku in listing_skus if str(sku.get("skuId") or "") not in seen_ids)
    gallery = goods.get("goodsGallery") or {}
    gallery_images = gallery.get("goodsCarouselImage") or []
    sku_images = [image for sku in skus for image in (sku.get("images") or [])]

    def ean_values(sku: dict[str, Any]) -> list[str]:
        barcodes = sku.get("barCodeList") or []
        if isinstance(barcodes, dict):
            barcodes = [barcodes]
        return [
            str(value)
            for barcode in barcodes
            for value in (barcode.get("barCodeIdList") or [])
            if value
        ]

    return {
        "statusFilter": status,
        "goodsId": str(goods.get("goodsId") or listing.get("goodsId") or ""),
        "goodsStatus": listing.get("status4VO", goods.get("goodsStatus", "")),
        "subStatus": listing.get("subStatus4VO", goods.get("subStatus", "")),
        "outGoodsSn": str(goods.get("outGoodsSn") or listing.get("outGoodsSn") or ""),
        "catId": str(goods.get("catId") or listing.get("catId") or ""),
        "hasGoodsDesc": bool(goods.get("goodsDesc")),
        "bulletPointCount": len(goods.get("bulletPoints") or []),
        "skus": [
            {
                "outSkuSn": str(sku.get("outSkuSn") or sku.get("skuSn") or ""),
                "skuId": str(sku.get("skuId") or ""),
                "quantity": sku.get("quantity", listing.get("quantity")),
                "hasExternalProductId": bool(sku.get("externalProductId")),
                "eanValues": ean_values(sku),
                "skuImageCount": len(sku.get("images") or []),
            }
            for sku in skus
        ],
        "productImageCount": max(len(gallery_images), len(sku_images)),
        "processing150010205": _has_code(goods, "150010205") or _has_code(listing, "150010205"),
    }


def _report_ip_whitelist_error(error: TemuApiError) -> None:
    ip_result = subprocess.run(
        ["curl", "-s", "https://api.ipify.org"], capture_output=True, text=True, timeout=15
    )
    ip = ip_result.stdout.strip() if ip_result.returncode == 0 else "unavailable"
    print(f"IP_WHITELIST_BLOCK code={error.code} message={error.message} public_ip={ip}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path, help="Path to the local env file; values are never printed.")
    args = parser.parse_args()
    if not args.env_file.is_file():
        print("CONFIG_ERROR env file unavailable", file=sys.stderr)
        return 2
    try:
        creds = TemuCredentials.from_mapping(dotenv_values(args.env_file))
    except ValueError as exc:
        print(f"CONFIG_ERROR {exc}", file=sys.stderr)
        return 2

    client = TemuClient(creds)
    try:
        listings = {status: _list_status(client, status) for status in STATUSES}
        print(f"STATUS_1_COUNT {len(listings[1])}")
        for status in STATUSES[1:]:
            print(f"STATUS_{status}_COUNT {len(listings[status])}")

        detail_targets: dict[str, tuple[int, dict[str, Any]]] = {}
        for status in DETAIL_STATUSES:
            for item in listings[status]:
                goods_id = item.get("goodsId")
                if goods_id is not None:
                    detail_targets[str(goods_id)] = (status, item)
        print(f"DETAIL_TARGETS {len(detail_targets)}")

        summaries: list[dict[str, Any]] = []
        for goods_id, (status, listing) in detail_targets.items():
            detail = client.goods_detail(goods_id)
            summaries.append(_product_summary(status, listing, detail))

        per_status: dict[str, dict[str, int]] = {}
        for status in DETAIL_STATUSES:
            products = [p for p in summaries if p["statusFilter"] == status]
            per_status[str(status)] = {
                "details": len(products),
                "missingDescription": sum(not p["hasGoodsDesc"] for p in products),
                "missingBullets": sum(p["bulletPointCount"] == 0 for p in products),
                "missingExternalProductId": sum(
                    any(not sku["hasExternalProductId"] for sku in p["skus"]) for p in products
                ),
                "missingEan": sum(any(not sku["eanValues"] for sku in p["skus"]) for p in products),
                "fewerThanThreeImages": sum(p["productImageCount"] < 3 for p in products),
                "zeroQuantity": sum(any(sku["quantity"] == 0 for sku in p["skus"]) for p in products),
            }
        fixable_candidates = [
            {
                "statusFilter": p["statusFilter"],
                "goodsId": p["goodsId"],
                "sku": p["outGoodsSn"] or next((s["outSkuSn"] for s in p["skus"] if s["outSkuSn"]), ""),
                "missing": [
                    name
                    for name, absent in (
                        ("goodsDesc", not p["hasGoodsDesc"]),
                        ("bulletPoints", p["bulletPointCount"] == 0),
                        ("externalProductId", any(not sku["hasExternalProductId"] for sku in p["skus"])),
                        ("EAN", any(not sku["eanValues"] for sku in p["skus"])),
                        ("images", p["productImageCount"] < 3),
                    )
                    if absent
                ],
                "processing150010205": p["processing150010205"],
            }
            for p in summaries
            if (p["outGoodsSn"] or any(sku["outSkuSn"] for sku in p["skus"]))
            and any(
                [not p["hasGoodsDesc"], p["bulletPointCount"] == 0, p["productImageCount"] < 3]
                + [not sku["hasExternalProductId"] or not sku["eanValues"] for sku in p["skus"]]
            )
        ]
        print("AUDIT_SUMMARY " + json.dumps({
            "status1Count": len(listings[1]),
            "statusCounts": {str(k): len(v) for k, v in listings.items()},
            "detailTargets": len(detail_targets),
            "detailsByStatus": per_status,
            "fixableCandidatesWithSku": fixable_candidates,
            "processingGoodsIds": [p["goodsId"] for p in summaries if p["processing150010205"]],
        }, ensure_ascii=False, separators=(",", ":")))
    except TemuApiError as exc:
        if exc.is_ip_whitelist_error:
            _report_ip_whitelist_error(exc)
            return 3
        print(f"TEMU_API_ERROR code={exc.code} message={exc.message}", file=sys.stderr)
        return 4
    print("READ_AUDIT_COMPLETE; no product updates were issued")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
