#!/usr/bin/env python3
"""Plan or apply source-backed, status-guarded Temu ES catalog corrections."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from dotenv import dotenv_values

from lib.temu_client import TemuApiError, TemuClient, TemuCredentials

MARKETPLACE_ID = "A1RKKUPIHCS9HS"
EU_SPAPI = "https://sellingpartnerapi-eu.amazon.com"
STATUS_FILTERS = (1, 2, 4, 5, 6)
DETAIL_FILTERS = (2, 4, 5, 6)


class ApiPacer:
    def __init__(self, gap: float = 0.2) -> None:
        self.gap = max(0.15, min(0.25, gap))
        self.last = 0.0

    def wait(self) -> None:
        elapsed = time.monotonic() - self.last
        if self.last and elapsed < self.gap:
            time.sleep(self.gap - elapsed)
        self.last = time.monotonic()


def _rows(data: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        return data.get(key) or []
    return data if isinstance(data, list) else []


def _contains_code(value: Any, code: str) -> bool:
    if isinstance(value, dict):
        return any(_contains_code(item, code) for item in value.values())
    if isinstance(value, list):
        return any(_contains_code(item, code) for item in value)
    return str(value) == code


def _localized(value: Any, language_prefix: str = "es") -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    records = [row for row in value if isinstance(row, dict) and row.get("value")]
    spanish = [row for row in records if str(row.get("language_tag", "")).lower().startswith(language_prefix)]
    candidates = spanish or [row for row in records if not row.get("language_tag")]
    return str(candidates[0].get("value", "")).strip() if candidates else ""


class ReadSources:
    def __init__(self, env: dict[str, Any], pacer: ApiPacer):
        self.env = env
        self.pacer = pacer
        self.session = requests.Session()
        self.ps_base = str(env["PS_URL"]).rstrip("/") + "/api"
        self.sp_token = self._get_spapi_token()
        self.sp_headers = {"x-amz-access-token": self.sp_token, "accept": "application/json"}
        self.seller_id = str(env["SP_API_SELLER_ID"])

    def _get_spapi_token(self) -> str:
        required = ("SP_API_REFRESH_TOKEN", "LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "SP_API_SELLER_ID")
        missing = [key for key in required if not self.env.get(key)]
        if missing:
            raise ValueError("Missing Amazon configuration keys: " + ", ".join(missing))
        self.pacer.wait()
        response = self.session.post(
            "https://api.amazon.com/auth/o2/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.env["SP_API_REFRESH_TOKEN"],
                "client_id": self.env["LWA_CLIENT_ID"],
                "client_secret": self.env["LWA_CLIENT_SECRET"],
            },
            timeout=30,
        )
        if not response.ok:
            raise RuntimeError(f"Amazon LWA HTTP {response.status_code}")
        return str(response.json()["access_token"])

    def _ps_get(self, resource: str, params: dict[str, str]) -> requests.Response:
        if not self.env.get("PS_API_KEY") or not self.env.get("PS_URL"):
            raise ValueError("Missing PrestaShop configuration keys: PS_URL, PS_API_KEY")
        params = {**params, "output_format": "JSON"}
        self.pacer.wait()
        return self.session.get(
            f"{self.ps_base}/{resource}", params=params, auth=(str(self.env["PS_API_KEY"]), ""), timeout=30
        )

    def prestashop_product(self, sku: str) -> dict[str, Any] | None:
        response = self._ps_get(
            "products", {"filter[reference]": f"[{sku}]", "display": "[id,reference,ean13,description]"}
        )
        if not response.ok:
            raise RuntimeError(f"PrestaShop product HTTP {response.status_code}")
        products = _rows(response.json(), "products")
        exact = [row for row in products if str(row.get("reference", "")).strip() == sku]
        return exact[0] if len(exact) == 1 else None

    def prestashop_stock(self, product: dict[str, Any]) -> int | None:
        response = self._ps_get(
            "stock_availables",
            {
                "filter[id_product]": f"[{product.get('id')}]",
                "display": "[id_product,id_product_attribute,quantity]",
            },
        )
        if not response.ok:
            raise RuntimeError(f"PrestaShop stock HTTP {response.status_code}")
        rows = _rows(response.json(), "stock_availables")
        # A product may have variant-specific stock rows; without a verified
        # Temu-to-PrestaShop attribute mapping, none is an exact SKU quantity.
        if len(rows) != 1 or str(rows[0].get("id_product_attribute", "0")) not in ("", "0"):
            return None
        return int(rows[0].get("quantity") or 0)

    def listing_asin(self, sku: str) -> str | None:
        path = f"/listings/2021-08-01/items/{quote(self.seller_id, safe='')}/{quote(sku, safe='')}"
        self.pacer.wait()
        response = self.session.get(
            EU_SPAPI + path,
            headers=self.sp_headers,
            params={"marketplaceIds": MARKETPLACE_ID, "includedData": "summaries"},
            timeout=30,
        )
        if not response.ok:
            raise RuntimeError(f"Amazon listing lookup HTTP {response.status_code}")
        summaries = response.json().get("summaries") or []
        return str(summaries[0].get("asin")) if summaries and summaries[0].get("asin") else None

    def catalog_item(self, asin: str) -> dict[str, Any]:
        self.pacer.wait()
        response = self.session.get(
            f"{EU_SPAPI}/catalog/2022-04-01/items/{quote(asin, safe='')}",
            headers=self.sp_headers,
            params={"marketplaceIds": MARKETPLACE_ID, "includedData": "attributes,identifiers"},
            timeout=30,
        )
        if not response.ok:
            raise RuntimeError(f"Amazon Catalog Items HTTP {response.status_code}")
        return response.json()

    def b2c_prices(self, asins: list[str]) -> dict[str, dict[str, str]]:
        if not asins:
            return {}
        body = {
            "requests": [
                {
                    "uri": f"/products/pricing/v0/items/{asin}/offers",
                    "method": "GET",
                    "MarketplaceId": MARKETPLACE_ID,
                    "ItemCondition": "New",
                }
                for asin in asins
            ]
        }
        self.pacer.wait()
        response = self.session.post(
            f"{EU_SPAPI}/batches/products/pricing/v0/itemOffers",
            headers={**self.sp_headers, "content-type": "application/json"},
            json=body,
            timeout=30,
        )
        if not response.ok:
            raise RuntimeError(f"Amazon item-offers batch HTTP {response.status_code}")
        prices: dict[str, dict[str, str]] = {}
        for asin, row in zip(asins, response.json().get("responses") or []):
            payload = (row.get("body") or {}).get("payload") or {}
            offers = payload.get("Offers") or []
            own = [offer for offer in offers if offer.get("SellerId") == self.seller_id]
            buybox = next((offer for offer in offers if offer.get("IsBuyBoxWinner")), None)
            selected = own[0] if own else buybox
            amount = (selected or {}).get("ListingPrice") or {}
            if amount.get("Amount") and amount.get("CurrencyCode"):
                prices[asin] = {"amount": str(amount["Amount"]), "currency": str(amount["CurrencyCode"])}
        return prices


def _catalog_ean(item: dict[str, Any]) -> str:
    for block in item.get("identifiers") or []:
        if block.get("marketplaceId") not in (None, MARKETPLACE_ID):
            continue
        for identifier in block.get("identifiers") or []:
            if str(identifier.get("identifierType", "")).upper() == "EAN":
                value = str(identifier.get("identifier", "")).strip()
                if value:
                    return value
    return ""


def _source_facts(sku: str, asin: str, item: dict[str, Any], ps_product: dict[str, Any] | None) -> dict[str, Any]:
    attrs = item.get("attributes") or {}
    description = _localized(attrs.get("product_description"))
    bullets = [
        value
        for value in (_localized([row]) for row in (attrs.get("bullet_point") or []))
        if value and len(value) <= 200
    ][:5]
    ean = _catalog_ean(item)
    if not ean and ps_product:
        candidate = str(ps_product.get("ean13") or "").strip()
        if candidate.isdigit() and len(candidate) == 13:
            ean = candidate
    return {"sku": sku, "asin": asin, "description": description, "bulletPoints": bullets, "ean": ean}


def _list_all(client: TemuClient, status: int) -> list[dict[str, Any]]:
    result = client.list_goods(status, page_no=1, page_size=100).get("result") or {}
    items = result.get("goodsList") or []
    page = 2
    while len(items) < int(result.get("total", len(items))):
        next_result = client.list_goods(status, page_no=page, page_size=100).get("result") or {}
        batch = next_result.get("goodsList") or []
        if not batch:
            break
        items.extend(batch)
        page += 1
    return items


def _current_detail(client: TemuClient, listing: dict[str, Any]) -> dict[str, Any]:
    return client.goods_detail(listing["goodsId"])


def _ean_missing(sku: dict[str, Any]) -> bool:
    codes = sku.get("barCodeList") or []
    if isinstance(codes, dict):
        codes = [codes]
    return not any(
        str(code.get("identifierType", code.get("barCodeType", ""))).upper() in ("EAN", "GTIN")
        and (code.get("barCodeIdList") or code.get("barCodeId"))
        for code in codes
        if isinstance(code, dict)
    )


def _price_from_detail(sku: dict[str, Any]) -> str:
    retail = sku.get("retailPrice") or ((sku.get("price") or {}).get("retailPrice")) or {}
    return str(retail.get("amount", ""))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Send guarded Temu updates; without this, only print the plan.")
    args = parser.parse_args()
    if not args.env_file.is_file():
        print("CONFIG_ERROR env file unavailable", file=sys.stderr)
        return 2
    env = dotenv_values(args.env_file)
    try:
        credentials = TemuCredentials.from_mapping(env)
        if not env.get("PS_URL") or not env.get("PS_API_KEY"):
            raise ValueError("Missing PrestaShop configuration keys: PS_URL, PS_API_KEY")
        pacer = ApiPacer()
        sources = ReadSources(env, pacer)
        temu = TemuClient(credentials)
    except (ValueError, RuntimeError) as exc:
        print(f"CONFIG_ERROR {exc}", file=sys.stderr)
        return 2

    try:
        listings = {status: _list_all(temu, status) for status in STATUS_FILTERS}
        # Status 1 is counted only. It is never detailed or included in an update plan.
        print("STATUS_COUNTS " + json.dumps({str(k): len(v) for k, v in listings.items()}, separators=(",", ":")))

        candidates: dict[tuple[str, str], tuple[int, dict[str, Any], dict[str, Any]]] = {}
        zero_stock: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
        unmatched: list[dict[str, Any]] = []
        for status in DETAIL_FILTERS:
            for listing in listings[status]:
                detail = _current_detail(temu, listing)
                goods = detail.get("result") or {}
                if _contains_code(detail, "150010205"):
                    continue
                detail_skus = {str(s.get("skuId")): s for s in (goods.get("skuList") or [])}
                listed_skus = listing.get("skuInfoList") or []
                if not listed_skus and (not goods.get("goodsDesc") or not (goods.get("bulletPoints") or [])):
                    unmatched.append({"status": status, "goodsId": str(listing.get("goodsId")), "sku": "", "reason": "No Temu SKU mapping"})
                for listed_sku in listed_skus:
                    sku_id = str(listed_sku.get("skuId") or "")
                    code = str(listed_sku.get("skuSn") or listed_sku.get("outSkuSn") or "").strip()
                    qty = listed_sku.get("quantity", listed_sku.get("stock"))
                    detail_sku = detail_skus.get(sku_id, {})
                    if qty == 0 and code:
                        zero_stock.append((status, listing, listed_sku))
                    if not code and (
                        not goods.get("goodsDesc") or not (goods.get("bulletPoints") or [])
                        or not detail_sku.get("externalProductId") or _ean_missing(detail_sku)
                    ):
                        unmatched.append({
                            "status": status, "goodsId": str(listing.get("goodsId")),
                            "skuId": sku_id, "sku": "", "reason": "No source-matchable Temu SKU code",
                        })
                    if code and any(
                        [
                            not goods.get("goodsDesc"),
                            not (goods.get("bulletPoints") or []),
                            not detail_sku.get("externalProductId"),
                            _ean_missing(detail_sku),
                        ]
                    ):
                        candidates[(str(listing.get("goodsId")), sku_id)] = (status, listing, detail)

        plans: list[dict[str, Any]] = []
        source_by_asin: dict[str, dict[str, Any]] = {}
        asin_by_key: dict[tuple[str, str], str] = {}
        asin_by_plan: dict[tuple[str, str], str] = {}
        for key, (status, listing, detail) in candidates.items():
            sku_id = key[1]
            matching = next(
                (row for row in (listing.get("skuInfoList") or []) if str(row.get("skuId")) == sku_id), {}
            )
            sku = str(matching.get("skuSn") or matching.get("outSkuSn") or "").strip()
            detail_goods = detail.get("result") or {}
            detail_sku = next(
                (row for row in (detail_goods.get("skuList") or []) if str(row.get("skuId")) == sku_id), {}
            )
            ps_product = sources.prestashop_product(sku)
            asin = sources.listing_asin(sku)
            if not asin:
                plans.append({"status": status, "goodsId": str(listing.get("goodsId")), "sku": sku, "ready": False, "reason": "Amazon Catalog ASIN unavailable"})
                continue
            catalog = sources.catalog_item(asin)
            facts = _source_facts(sku, asin, catalog, ps_product)
            if facts["description"] and len(facts["description"]) > 2000:
                facts["description"] = ""
            source_by_asin[asin] = facts
            asin_by_key[key] = asin
            asin_by_plan[(str(listing.get("goodsId")), sku)] = asin
            missing = []
            if not detail_goods.get("goodsDesc") and not facts["description"]:
                missing.append("goodsDesc")
            if not (detail_goods.get("bulletPoints") or []) and not facts["bulletPoints"]:
                missing.append("bulletPoints")
            if not detail_sku.get("externalProductId") and not facts["asin"]:
                missing.append("externalProductId")
            if _ean_missing(detail_sku) and not facts["ean"]:
                missing.append("EAN")
            plans.append({
                "status": status,
                "goodsId": str(listing.get("goodsId")),
                "sku": sku,
                "ready": not missing,
                "missing": missing,
                "amazonPrice": "pending",
                "prestaShopMatched": bool(ps_product),
            })

        # One batch gives current consumer offer prices for the Amazon ES marketplace.
        prices = sources.b2c_prices(list(source_by_asin))
        for plan in plans:
            asin = asin_by_plan.get((str(plan["goodsId"]), plan["sku"]))
            if asin and asin in prices:
                plan["amazonPrice"] = prices[asin]
            elif plan.get("ready"):
                plan["ready"] = False
                plan["reason"] = "Amazon ES B2C offer unavailable; price cannot be safely synchronized"

        print("CORRECTION_PLAN " + json.dumps(plans, ensure_ascii=False, separators=(",", ":")))
        if unmatched:
            print("UNMATCHED_PRODUCTS " + json.dumps(unmatched, separators=(",", ":")))
        if not args.apply:
            stock_preview = []
            for status, listing, listed_sku in zero_stock:
                sku = str(listed_sku.get("skuSn") or listed_sku.get("outSkuSn") or "").strip()
                product = sources.prestashop_product(sku) if sku else None
                stock = sources.prestashop_stock(product) if product else None
                stock_preview.append({"goodsId": str(listing.get("goodsId")), "sku": sku, "prestaShopStock": stock})
            print("ZERO_STOCK_SOURCE_CHECK " + json.dumps(stock_preview, separators=(",", ":")))
            print("DRY_RUN_COMPLETE; no product updates were issued")
            return 0

        outcomes: list[dict[str, Any]] = []
        plan_by_goods_sku = {(str(p["goodsId"]), p["sku"]): p for p in plans}
        for (goods_id, sku_id), (status, listing, detail) in candidates.items():
            sku_row = next((row for row in (listing.get("skuInfoList") or []) if str(row.get("skuId")) == sku_id), {})
            sku = str(sku_row.get("skuSn") or sku_row.get("outSkuSn") or "").strip()
            plan = plan_by_goods_sku.get((goods_id, sku), {})
            if not plan.get("ready"):
                reason = plan.get("reason", ",".join(plan.get("missing") or []))
                action = (
                    "Seller Center: restore/confirm a current Amazon ES consumer offer, then rerun the guarded update."
                    if "B2C offer unavailable" in reason else
                    "Seller Center: verify the correct Temu SKU-to-Amazon ASIN/PrestaShop reference before editing."
                )
                outcomes.append({"goodsId": goods_id, "sku": sku, "result": "requiere_revision_manual", "reason": reason, "sellerCenterAction": action})
                continue
            asin = asin_by_key.get((goods_id, sku_id))
            facts = source_by_asin[asin]
            current = detail.get("result") or {}
            detail_sku = next((row for row in (current.get("skuList") or []) if str(row.get("skuId")) == sku_id), {})
            payload: dict[str, Any] = {"goodsId": int(goods_id)}
            if not current.get("goodsDesc"):
                payload["goodsDesc"] = facts["description"]
            if not (current.get("bulletPoints") or []):
                payload["bulletPoints"] = facts["bulletPoints"]
            sku_update: dict[str, Any] = {"skuId": int(sku_id)}
            if not detail_sku.get("externalProductId"):
                sku_update["externalProductId"] = asin
            if _ean_missing(detail_sku):
                sku_update["barCodeList"] = [{"barCodeType": "EAN", "barCodeIdList": [facts["ean"]]}]
            price = plan.get("amazonPrice")
            if isinstance(price, dict):
                sku_update["retailPrice"] = price
            payload["skuList"] = [sku_update]

            try:
                # Defensive reread: never write if the current product has become a status-1 item.
                latest = _list_all(temu, status)
                latest_listing = next((row for row in latest if str(row.get("goodsId")) == goods_id), None)
                if not latest_listing or latest_listing.get("status4VO") == 1 or _contains_code(latest_listing, "150010205"):
                    outcomes.append({"goodsId": goods_id, "sku": sku, "result": "skipped", "reason": "status changed or Temu processing"})
                    continue
                response = temu.request("bg.local.goods.partial.update", payload)
                verified = (temu.goods_detail(goods_id).get("result") or {})
                verified_sku = next((row for row in (verified.get("skuList") or []) if str(row.get("skuId")) == sku_id), {})
                fields_ok = (
                    (not payload.get("goodsDesc") or verified.get("goodsDesc") == payload["goodsDesc"])
                    and (not payload.get("bulletPoints") or verified.get("bulletPoints") == payload["bulletPoints"])
                    and (not sku_update.get("externalProductId") or verified_sku.get("externalProductId") == asin)
                    and (not sku_update.get("barCodeList") or not _ean_missing(verified_sku))
                )
                if isinstance(price, dict):
                    fields_ok = fields_ok and _price_from_detail(verified_sku) == price["amount"]
                outcomes.append({"goodsId": goods_id, "sku": sku, "result": "updated_and_verified" if fields_ok else "requiere_revision_manual", "price": price, "responseSuccess": bool(response.get("success"))})
            except TemuApiError as exc:
                action = "Seller Center: review the product's active review task/status; wait for review to finish or resolve it, then submit the content correction."
                if exc.code == "150011000":
                    category_id = (detail.get("result") or {}).get("catId")
                    try:
                        template = temu.request("bg.local.goods.template.get", {"catId": category_id})
                        template_result = template.get("result") or {}
                        # The template is fetched and reported for manual mapping;
                        # no unknown/electrical value is guessed from catalog text.
                        check = temu.request(
                            "bg.local.goods.compliance.property.check",
                            {"catId": category_id, "goodsId": int(goods_id), "propertyList": []},
                        )
                        action = (
                            "Seller Center: map mandatory template fields to verified Amazon/PrestaShop facts; "
                            "the empty-facts compliance check did not authorize a product update."
                        )
                        outcomes.append({
                            "goodsId": goods_id, "sku": sku, "result": "requiere_revision_manual",
                            "temuErrorCode": exc.code, "temuErrorMessage": exc.message,
                            "templateFetched": bool(template_result), "complianceCheckSuccess": bool(check.get("success")),
                            "sellerCenterAction": action,
                        })
                        continue
                    except TemuApiError as followup:
                        outcomes.append({
                            "goodsId": goods_id, "sku": sku, "result": "requiere_revision_manual",
                            "temuErrorCode": exc.code, "temuErrorMessage": exc.message,
                            "followupErrorCode": followup.code, "followupErrorMessage": followup.message,
                            "sellerCenterAction": "Seller Center: inspect category template/compliance requirements and fill only documented values supported by product facts.",
                        })
                        continue
                outcomes.append({"goodsId": goods_id, "sku": sku, "result": "requiere_revision_manual", "temuErrorCode": exc.code, "temuErrorMessage": exc.message, "sellerCenterAction": action})

        for status, listing, listed_sku in zero_stock:
            sku = str(listed_sku.get("skuSn") or listed_sku.get("outSkuSn") or "").strip()
            product = sources.prestashop_product(sku) if sku else None
            ps_stock = sources.prestashop_stock(product) if product else None
            if not product or ps_stock is None or ps_stock <= 0:
                outcomes.append({"goodsId": str(listing["goodsId"]), "sku": sku, "result": "stock_unchanged", "prestaShopStock": ps_stock, "reason": "No positive exact-SKU PrestaShop stock confirmation"})
                continue
            latest = _list_all(temu, status)
            latest_listing = next((row for row in latest if str(row.get("goodsId")) == str(listing["goodsId"])), None)
            current_sku = next(
                (row for row in (latest_listing or {}).get("skuInfoList", []) if str(row.get("skuId")) == str(listed_sku.get("skuId"))),
                None,
            )
            if not latest_listing or latest_listing.get("status4VO") == 1 or not current_sku or current_sku.get("quantity") != 0:
                outcomes.append({"goodsId": str(listing["goodsId"]), "sku": sku, "result": "stock_unchanged", "prestaShopStock": ps_stock, "reason": "Status or quantity changed since audit"})
                continue
            try:
                temu.request("bg.local.goods.stock.edit", {
                    "goodsId": int(listing["goodsId"]),
                    "skuStockTargetList": [{"skuId": int(listed_sku["skuId"]), "stockTarget": ps_stock}],
                })
                verify_listing = next(
                    (row for row in _list_all(temu, status) if str(row.get("goodsId")) == str(listing["goodsId"])),
                    None,
                )
                verify_sku = next(
                    (row for row in (verify_listing or {}).get("skuInfoList", []) if str(row.get("skuId")) == str(listed_sku["skuId"])),
                    {},
                )
                ok = verify_sku.get("quantity") == ps_stock
                outcomes.append({"goodsId": str(listing["goodsId"]), "sku": sku, "result": "stock_updated_and_verified" if ok else "requiere_revision_manual", "quantity": ps_stock})
            except TemuApiError as exc:
                outcomes.append({"goodsId": str(listing["goodsId"]), "sku": sku, "result": "requiere_revision_manual", "temuErrorCode": exc.code, "temuErrorMessage": exc.message, "sellerCenterAction": "Seller Center: set the exact SKU stock to the confirmed PrestaShop quantity."})

        print("CORRECTION_RESULTS " + json.dumps(outcomes, ensure_ascii=False, separators=(",", ":")))
        print("APPLY_COMPLETE")
        return 0
    except TemuApiError as exc:
        if exc.is_ip_whitelist_error:
            result = subprocess.run(["curl", "-s", "https://api.ipify.org"], capture_output=True, text=True, timeout=15)
            print("IP_WHITELIST_BLOCK", "code=" + exc.code, "message=" + exc.message, "public_ip=" + (result.stdout.strip() if result.returncode == 0 else "unavailable"), file=sys.stderr)
            return 3
        print(f"TEMU_API_ERROR code={exc.code} message={exc.message}", file=sys.stderr)
        return 4
    except (requests.RequestException, RuntimeError, ValueError) as exc:
        # RuntimeError messages above contain only HTTP status / field names;
        # request exceptions are kept generic to avoid echoing URLs or headers.
        detail = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else type(exc).__name__
        print(f"SOURCE_ERROR {detail}", file=sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
