#!/usr/bin/env python3
"""
sync_external_sales.py

Descarga y sincroniza las ventas de PrestaShop y Cdiscount (2025 y 2026).
Genera archivos CSV compatibles con la estructura unificada de ventas:
  - ventas_prestashop_2025.csv
  - ventas_prestashop_2026.csv
  - ventas_cdiscount_2025.csv
  - ventas_cdiscount_2026.csv
"""

import os
import csv
import json
import time
import requests
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / "backend" / ".env")

CSV_HEADERS = [
    "amazon-order-id",
    "merchant-order-id",
    "purchase-date",
    "last-updated-date",
    "order-status",
    "fulfillment-channel",
    "sales-channel",
    "order-channel",
    "ship-service-level",
    "product-name",
    "sku",
    "asin",
    "item-status",
    "quantity",
    "currency",
    "item-price",
    "item-tax",
    "shipping-price",
    "shipping-tax",
    "gift-wrap-price",
    "gift-wrap-tax",
    "item-promotion-discount",
    "ship-promotion-discount",
    "ship-city",
    "ship-state",
    "ship-postal-code",
    "ship-country",
    "promotion-ids",
    "is-business-order",
    "purchase-order-number",
    "price-designation",
    "fulfilled-by",
    "buyer-tax-registration-country",
    "buyer-tax-registration-type",
    "is-iba",
    "order-invoice-type",
    "order-item-id",
    "is-prime"
]

def format_num(val) -> str:
    if val is None or val == "":
        return "0"
    try:
        f = float(str(val).replace(",", "."))
        return f"{f:.2f}"
    except Exception:
        return "0"

def write_csv(filename: str, rows: list):
    filepath = BASE_DIR / filename
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(CSV_HEADERS)
        for r in rows:
            writer.writerow([r.get(h, "") for h in CSV_HEADERS])
    print(f"✅ Guardado {filename} con {len(rows)} filas.")

# -------------------------------------------------------------
# PrestaShop
# -------------------------------------------------------------
def sync_prestashop():
    print("\n--- Sincronizando PrestaShop ---")
    ps_url = os.getenv("PS_URL", "https://www.vidalregals.com").rstrip("/")
    ps_key = os.getenv("PS_API_KEY", "")
    if not ps_key:
        print("⚠️ PS_API_KEY no encontrada en .env")
        return

    # Traer todos los pedidos con display=full
    print("Descargando pedidos de PrestaShop...")
    resp = requests.get(
        f"{ps_url}/api/orders",
        params={"output_format": "JSON", "display": "full", "ws_key": ps_key},
        timeout=90
    )
    if resp.status_code != 200:
        print(f"❌ Error al consultar PrestaShop: {resp.status_code} {resp.text[:300]}")
        return

    orders = resp.json().get("orders", [])
    print(f"Total pedidos PrestaShop recibidos: {len(orders)}")

    rows_2025 = []
    rows_2026 = []

    # Estado 6 = Cancelado, 8 = Error en el pago
    cancelled_states = {"6", "8"}

    for o in orders:
        date_add = (o.get("date_add") or "").strip()
        if not date_add or len(date_add) < 4:
            continue
        year = date_add[:4]
        if year not in ("2025", "2026"):
            continue

        order_id = str(o.get("id") or "")
        ref = str(o.get("reference") or order_id)
        current_state = str(o.get("current_state") or "")
        status = "Cancelled" if current_state in cancelled_states else "Shipped"

        # Fecha en formato ISO UTC
        purchase_date = date_add.replace(" ", "T") + "+00:00"
        date_upd = (o.get("date_upd") or date_add).replace(" ", "T") + "+00:00"

        total_shipping = float(o.get("total_shipping_tax_incl") or 0)
        shipping_tax = float(o.get("total_shipping_tax_incl") or 0) - float(o.get("total_shipping_tax_excl") or 0)
        total_discounts = float(o.get("total_discounts_tax_incl") or 0)

        assoc = o.get("associations") or {}
        order_rows = assoc.get("order_rows") or []
        if isinstance(order_rows, dict):
            order_rows = [order_rows]

        num_items = len(order_rows) if order_rows else 1

        if not order_rows:
            # Pedido sin desglose de líneas
            row_data = {
                "amazon-order-id": f"PS-{order_id}",
                "merchant-order-id": ref,
                "purchase-date": purchase_date,
                "last-updated-date": date_upd,
                "order-status": status,
                "fulfillment-channel": "Merchant",
                "sales-channel": "PrestaShop",
                "order-channel": "vidalregals.com",
                "ship-service-level": "Standard",
                "product-name": "Pedido PrestaShop",
                "sku": f"PS-{order_id}",
                "asin": "",
                "item-status": status,
                "quantity": "1",
                "currency": "EUR",
                "item-price": format_num(float(o.get("total_products_wt") or o.get("total_paid_tax_incl") or 0)),
                "item-tax": format_num(float(o.get("total_paid_tax_incl") or 0) - float(o.get("total_paid_tax_excl") or 0)),
                "shipping-price": format_num(total_shipping),
                "shipping-tax": format_num(shipping_tax),
                "gift-wrap-price": "0",
                "gift-wrap-tax": "0",
                "item-promotion-discount": format_num(-abs(total_discounts)) if total_discounts else "0",
                "ship-promotion-discount": "0",
                "ship-city": "",
                "ship-state": "",
                "ship-postal-code": "",
                "ship-country": "ES",
                "promotion-ids": "",
                "is-business-order": "false",
                "purchase-order-number": "",
                "price-designation": "",
                "fulfilled-by": "PrestaShop",
                "buyer-tax-registration-country": "",
                "buyer-tax-registration-type": "",
                "is-iba": "false",
                "order-invoice-type": "",
                "order-item-id": f"PS-{order_id}-1",
                "is-prime": "false"
            }
            if year == "2025":
                rows_2025.append(row_data)
            else:
                rows_2026.append(row_data)
        else:
            for idx, item in enumerate(order_rows):
                qty = int(item.get("product_quantity") or 1)
                unit_price_tax_incl = float(item.get("unit_price_tax_incl") or item.get("product_price") or 0)
                unit_price_tax_excl = float(item.get("unit_price_tax_excl") or item.get("product_price") or 0)
                item_total_price = unit_price_tax_incl * qty
                item_tax = (unit_price_tax_incl - unit_price_tax_excl) * qty

                # Distribuir portes y descuentos en la primera línea para no duplicar
                ship_share = total_shipping if idx == 0 else 0
                ship_tax_share = shipping_tax if idx == 0 else 0
                disc_share = total_discounts if idx == 0 else 0

                sku = item.get("product_reference") or f"PROD-{item.get('product_id')}"
                p_name = item.get("product_name") or sku

                row_data = {
                    "amazon-order-id": f"PS-{order_id}",
                    "merchant-order-id": ref,
                    "purchase-date": purchase_date,
                    "last-updated-date": date_upd,
                    "order-status": status,
                    "fulfillment-channel": "Merchant",
                    "sales-channel": "PrestaShop",
                    "order-channel": "vidalregals.com",
                    "ship-service-level": "Standard",
                    "product-name": p_name,
                    "sku": sku,
                    "asin": item.get("product_ean13") or "",
                    "item-status": status,
                    "quantity": str(qty),
                    "currency": "EUR",
                    "item-price": format_num(item_total_price),
                    "item-tax": format_num(item_tax),
                    "shipping-price": format_num(ship_share),
                    "shipping-tax": format_num(ship_tax_share),
                    "gift-wrap-price": "0",
                    "gift-wrap-tax": "0",
                    "item-promotion-discount": format_num(-abs(disc_share)) if disc_share else "0",
                    "ship-promotion-discount": "0",
                    "ship-city": "",
                    "ship-state": "",
                    "ship-postal-code": "",
                    "ship-country": "ES",
                    "promotion-ids": "",
                    "is-business-order": "false",
                    "purchase-order-number": "",
                    "price-designation": "",
                    "fulfilled-by": "PrestaShop",
                    "buyer-tax-registration-country": "",
                    "buyer-tax-registration-type": "",
                    "is-iba": "false",
                    "order-invoice-type": "",
                    "order-item-id": f"PS-{order_id}-{item.get('id') or idx}",
                    "is-prime": "false"
                }
                if year == "2025":
                    rows_2025.append(row_data)
                else:
                    rows_2026.append(row_data)

    write_csv("ventas_prestashop_2025.csv", rows_2025)
    write_csv("ventas_prestashop_2026.csv", rows_2026)

# -------------------------------------------------------------
# Cdiscount
# -------------------------------------------------------------
def sync_cdiscount():
    print("\n--- Sincronizando Cdiscount ---")
    try:
        from cdiscount_client import CdiscountClient, API_BASE_URL
    except ImportError:
        print("❌ No se pudo importar CdiscountClient.")
        return

    c = CdiscountClient()
    headers = c.get_headers()

    rows_2025 = []
    rows_2026 = []

    page = 1
    total_orders_count = 0
    print("Descargando pedidos de Cdiscount...")

    while True:
        r = requests.get(
            f"{API_BASE_URL}/orders",
            headers=headers,
            params={"size": 100, "pageIndex": page},
            timeout=30
        )
        if r.status_code != 200:
            print(f"❌ Error al consultar Cdiscount (página {page}): {r.status_code} {r.text[:300]}")
            break

        items = r.json().get("items", [])
        if not items:
            break

        total_orders_count += len(items)

        for order in items:
            purchased_at = order.get("purchasedAt") or order.get("createdAt") or ""
            if not purchased_at or len(purchased_at) < 4:
                continue
            year = purchased_at[:4]
            if year not in ("2025", "2026"):
                continue

            order_id = str(order.get("orderId") or "")
            order_ref = str(order.get("reference") or order_id)
            c_status = str(order.get("status") or "")
            status = "Cancelled" if c_status.lower() == "cancelled" else "Shipped"

            updated_at = order.get("updatedAt") or purchased_at
            b_addr = order.get("billingAddress") or {}
            city = b_addr.get("city") or ""
            state = ""
            postal_code = b_addr.get("postalCode") or ""
            country = b_addr.get("countryCode") or "FR"

            currency = order.get("currencyCode") or "EUR"
            is_biz = "true" if order.get("businessOrder") else "false"

            lines = order.get("lines") or []
            if not lines:
                tot = order.get("totalPrice") or {}
                selling_price = float(tot.get("sellingPrice") or tot.get("offerPrice") or 0)
                row_data = {
                    "amazon-order-id": f"CD-{order_id}",
                    "merchant-order-id": order_ref,
                    "purchase-date": purchased_at,
                    "last-updated-date": updated_at,
                    "order-status": status,
                    "fulfillment-channel": "Merchant",
                    "sales-channel": "Cdiscount",
                    "order-channel": "Cdiscount.com",
                    "ship-service-level": "Standard",
                    "product-name": "Commande Cdiscount",
                    "sku": f"CD-{order_id}",
                    "asin": "",
                    "item-status": status,
                    "quantity": "1",
                    "currency": currency,
                    "item-price": format_num(selling_price),
                    "item-tax": "0",
                    "shipping-price": "0",
                    "shipping-tax": "0",
                    "gift-wrap-price": "0",
                    "gift-wrap-tax": "0",
                    "item-promotion-discount": "0",
                    "ship-promotion-discount": "0",
                    "ship-city": city,
                    "ship-state": state,
                    "ship-postal-code": postal_code,
                    "ship-country": country,
                    "promotion-ids": "",
                    "is-business-order": is_biz,
                    "purchase-order-number": "",
                    "price-designation": "",
                    "fulfilled-by": "Cdiscount",
                    "buyer-tax-registration-country": "",
                    "buyer-tax-registration-type": "",
                    "is-iba": "false",
                    "order-invoice-type": "",
                    "order-item-id": f"CD-{order_id}-1",
                    "is-prime": "false"
                }
                if year == "2025":
                    rows_2025.append(row_data)
                else:
                    rows_2026.append(row_data)
            else:
                for line in lines:
                    line_status = line.get("status") or status
                    l_status = "Cancelled" if str(line_status).lower() == "cancelled" else status
                    qty = int(line.get("quantity") or 1)

                    offer_obj = line.get("offer") or {}
                    sku = offer_obj.get("sellerProductId") or offer_obj.get("id") or "Sin SKU"
                    p_name = offer_obj.get("productTitle") or sku
                    ean = offer_obj.get("productGtin") or ""

                    s_price = line.get("sellingPrice") or line.get("totalPrice") or {}
                    unit_sales_price = float(s_price.get("unitSalesPrice") or 0)
                    line_shipping = float(s_price.get("shippingCost") or 0)

                    # Si unitSalesPrice es 0, intentar calcular desde totalPrice
                    if unit_sales_price == 0 and "sellingPrice" in s_price and isinstance(s_price["sellingPrice"], (int, float)):
                        tot_val = float(s_price["sellingPrice"])
                        unit_sales_price = (tot_val - line_shipping) / qty if qty > 0 else tot_val

                    item_price = unit_sales_price * qty
                    line_id = line.get("orderLineId") or "1"

                    row_data = {
                        "amazon-order-id": f"CD-{order_id}",
                        "merchant-order-id": order_ref,
                        "purchase-date": purchased_at,
                        "last-updated-date": updated_at,
                        "order-status": l_status,
                        "fulfillment-channel": "Merchant",
                        "sales-channel": "Cdiscount",
                        "order-channel": "Cdiscount.com",
                        "ship-service-level": "Standard",
                        "product-name": p_name,
                        "sku": sku,
                        "asin": ean,
                        "item-status": l_status,
                        "quantity": str(qty),
                        "currency": currency,
                        "item-price": format_num(item_price),
                        "item-tax": "0",
                        "shipping-price": format_num(line_shipping),
                        "shipping-tax": "0",
                        "gift-wrap-price": "0",
                        "gift-wrap-tax": "0",
                        "item-promotion-discount": "0",
                        "ship-promotion-discount": "0",
                        "ship-city": city,
                        "ship-state": state,
                        "ship-postal-code": postal_code,
                        "ship-country": country,
                        "promotion-ids": "",
                        "is-business-order": is_biz,
                        "purchase-order-number": "",
                        "price-designation": "",
                        "fulfilled-by": "Cdiscount",
                        "buyer-tax-registration-country": "",
                        "buyer-tax-registration-type": "",
                        "is-iba": "false",
                        "order-invoice-type": "",
                        "order-item-id": f"CD-{order_id}-{line_id}",
                        "is-prime": "false"
                    }
                    if year == "2025":
                        rows_2025.append(row_data)
                    else:
                        rows_2026.append(row_data)

        link_header = r.headers.get("Link", "")
        if 'rel="next"' not in link_header:
            break
        page += 1

    print(f"Total pedidos Cdiscount procesados: {total_orders_count}")
    write_csv("ventas_cdiscount_2025.csv", rows_2025)
    write_csv("ventas_cdiscount_2026.csv", rows_2026)

if __name__ == "__main__":
    sync_prestashop()
    sync_cdiscount()
    print("\n🎉 Sincronización de ventas de PrestaShop y Cdiscount completada con éxito.")
