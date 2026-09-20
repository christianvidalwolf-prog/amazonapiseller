import os
import sys
import time
import gzip
import csv
from datetime import datetime
import requests
from auth import get_access_token, get_base_url

DEFAULT_MARKETPLACE_ID = "A1RKKUPIHCS9HS"

# Meses de 2026 a procesar
MONTHS_2026 = [
    ("2026-01-01T00:00:00Z", "2026-01-31T23:59:59Z", "Enero 2026"),
    ("2026-02-01T00:00:00Z", "2026-02-28T23:59:59Z", "Febrero 2026"),
    ("2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z", "Marzo 2026"),
    ("2026-04-01T00:00:00Z", "2026-04-30T23:59:59Z", "Abril 2026"),
    ("2026-05-01T00:00:00Z", "2026-05-31T23:59:59Z", "Mayo 2026"),
    ("2026-06-01T00:00:00Z", "2026-06-30T23:59:59Z", "Junio 2026"),
    ("2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z", "Julio 2026"),
    ("2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z", "Agosto 2026"),
    ("2026-09-01T00:00:00Z", "2026-09-19T23:59:59Z", "Septiembre 2026"),
]

def request_and_download_report(start_time, end_time, label):
    """Solicita un reporte a Amazon Reports API, espera a que finalice y devuelve su contenido."""
    token = get_access_token()
    base_url = get_base_url()

    url_report = f"{base_url}/reports/2021-06-30/reports"
    payload = {
        "reportType": "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
        "marketplaceIds": [DEFAULT_MARKETPLACE_ID],
        "dataStartTime": start_time,
        "dataEndTime": end_time,
    }

    print(f"📥 Solicitando reporte para {label} ({start_time[:10]} al {end_time[:10]})...")
    
    # Reintento con backoff en caso de rate-limit
    for _ in range(5):
        res = requests.post(
            url_report,
            headers={"x-amz-access-token": token, "Content-Type": "application/json"},
            json=payload,
        )
        if res.status_code == 202:
            break
        elif res.status_code == 429:
            print("   ⚠️ Límite de tasa al solicitar reporte. Esperando 10s...")
            time.sleep(10)
        else:
            print(f"❌ Error al solicitar reporte ({res.status_code}): {res.text}")
            return []
    else:
        return []

    report_id = res.json().get("reportId")
    print(f"   Reporte en cola (ID: {report_id}). Esperando generación en Amazon...")

    # Esperar hasta que esté DONE
    for _ in range(40):
        time.sleep(3)
        status_res = requests.get(
            f"{base_url}/reports/2021-06-30/reports/{report_id}",
            headers={"x-amz-access-token": token},
        )
        if status_res.status_code != 200:
            continue
        data = status_res.json()
        status = data.get("processingStatus")
        if status == "DONE":
            doc_id = data.get("reportDocumentId")
            # Obtener URL del documento
            doc_res = requests.get(
                f"{base_url}/reports/2021-06-30/documents/{doc_id}",
                headers={"x-amz-access-token": token},
            ).json()
            doc_url = doc_res["url"]
            comp = doc_res.get("compressionAlgorithm")
            
            # Descargar archivo
            file_data = requests.get(doc_url)
            if comp == "GZIP":
                text = gzip.decompress(file_data.content).decode("latin-1", errors="replace")
            else:
                text = file_data.text
            
            lines = text.splitlines()
            if len(lines) <= 1:
                print(f"   ℹ️ {label}: Sin ventas registradas.")
                return []
            
            headers = lines[0].split("\t")
            rows = []
            for line in lines[1:]:
                parts = line.split("\t")
                if len(parts) == len(headers):
                    rows.append(dict(zip(headers, parts)))
            
            print(f"   ✅ {label}: {len(rows)} líneas de productos vendidas.")
            return rows

        elif status in ["FATAL", "CANCELLED"]:
            print(f"   ❌ El reporte terminó con estado {status}: {data}")
            return []
            
    print(f"   ⚠️ Tiempo de espera agotado para {label}.")
    return []

def main():
    print("=" * 80)
    print("🚀 EXTRAYENDO TODAS LAS VENTAS DE 2026 (SP-API REPORTS)")
    print("=" * 80)

    all_rows = []
    seen_keys = set()

    for start_time, end_time, label in MONTHS_2026:
        rows = request_and_download_report(start_time, end_time, label)
        for r in rows:
            # Evitar duplicados por item ID o combinación de pedido+SKU
            unique_key = r.get("order-item-id") or (r.get("amazon-order-id", "") + "_" + r.get("sku", ""))
            if unique_key not in seen_keys:
                seen_keys.add(unique_key)
                all_rows.append(r)
        time.sleep(2) # Pausa de cortesía

    if not all_rows:
        print("❌ No se obtuvieron registros de ventas.")
        return

    # Guardar en CSV completo delimitado por ;
    output_csv = "ventas_2026.csv"
    fieldnames = list(all_rows[0].keys())
    with open(output_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(all_rows)

    print("\n" + "=" * 80)
    print(f"💾 Archivo guardado con éxito: {output_csv} ({len(all_rows)} líneas)")
    print("=" * 80)

    # --- ANÁLISIS DE VENTAS ---
    # Filtrar solo pedidos válidos (no cancelados)
    valid_orders = [r for r in all_rows if r.get("order-status", "").lower() != "cancelled"]

    total_revenue = 0.0
    order_ids = set()
    total_units = 0
    by_channel = {}
    by_fulfillment = {}
    by_month = {}
    by_product = {}

    for r in valid_orders:
        oid = r.get("amazon-order-id")
        order_ids.add(oid)

        qty = int(r.get("quantity", 1) or 1)
        total_units += qty

        # Precio del producto
        price_str = r.get("item-price", "0").replace(",", ".")
        try:
            price = float(price_str) if price_str else 0.0
        except ValueError:
            price = 0.0
        total_revenue += price

        # Canal / Marketplace
        channel = r.get("sales-channel", "Desconocido")
        by_channel[channel] = by_channel.get(channel, 0.0) + price

        # Logística (FBA vs FBM)
        f_channel = r.get("fulfillment-channel", "Desconocido")
        by_fulfillment[f_channel] = by_fulfillment.get(f_channel, 0) + qty

        # Por Mes
        p_date = r.get("purchase-date", "")[:7] # YYYY-MM
        by_month[p_date] = by_month.get(p_date, 0.0) + price

        # Por Producto (SKU)
        sku = r.get("sku", "Sin SKU")
        name = r.get("product-name", "")[:50]
        if sku not in by_product:
            by_product[sku] = {"name": name, "units": 0, "revenue": 0.0}
        by_product[sku]["units"] += qty
        by_product[sku]["revenue"] += price

    print("\n📊 RESUMEN EJECUTIVO DE VENTAS 2026")
    print("-" * 80)
    print(f" • Facturación Total (Bruta):   {total_revenue:,.2f} €")
    print(f" • Total Pedidos Únicos:         {len(order_ids):,}")
    print(f" • Total Unidades Vendidas:      {total_units:,}")
    print(f" • Ticket Medio por Pedido:      {total_revenue / len(order_ids):,.2f} €" if order_ids else "")
    print(f" • Líneas de Pedido Totales:     {len(valid_orders):,}")

    print("\n🌍 Ventas por Canal / País:")
    for ch, rev in sorted(by_channel.items(), key=lambda x: x[1], reverse=True):
        pct = (rev / total_revenue * 100) if total_revenue > 0 else 0
        print(f"   • {ch:<18}: {rev:>10,.2f} €  ({pct:>5.1f}%)")

    print("\n🚚 Cumplimiento / Logística (Unidades):")
    for f_ch, units in sorted(by_fulfillment.items(), key=lambda x: x[1], reverse=True):
        f_label = "FBA (Amazon)" if "amazon" in f_ch.lower() or "afn" in f_ch.lower() else "FBM (Vendedor)"
        pct = (units / total_units * 100) if total_units > 0 else 0
        print(f"   • {f_label:<18} ({f_ch}): {units:>6,} uds ({pct:>5.1f}%)")

    print("\n📅 Evolución Mensual de Ventas (2026):")
    for m, rev in sorted(by_month.items()):
        print(f"   • {m}: {rev:>10,.2f} €")

    print("\n🏆 Top 10 Productos Más Vendidos (por Facturación):")
    sorted_prods = sorted(by_product.items(), key=lambda x: x[1]["revenue"], reverse=True)[:10]
    print(f"{'SKU':<18} {'UDS':>6} {'TOTAL €':>10}  NOMBRE")
    print("-" * 80)
    for sku, data in sorted_prods:
        print(f"{sku:<18} {data['units']:>6} {data['revenue']:>9,.2f} €  {data['name']}")

if __name__ == "__main__":
    main()
