import os
import sys
import time
import gzip
import csv
from datetime import datetime
import requests
from auth import get_access_token, get_base_url

DEFAULT_MARKETPLACE_ID = "A1RKKUPIHCS9HS"

# Meses de 2025 a procesar
MONTHS_2025 = [
    ("2025-01-01T00:00:00Z", "2025-01-31T23:59:59Z", "Enero 2025"),
    ("2025-02-01T00:00:00Z", "2025-02-28T23:59:59Z", "Febrero 2025"),
    ("2025-03-01T00:00:00Z", "2025-03-31T23:59:59Z", "Marzo 2025"),
    ("2025-04-01T00:00:00Z", "2025-04-30T23:59:59Z", "Abril 2025"),
    ("2025-05-01T00:00:00Z", "2025-05-31T23:59:59Z", "Mayo 2025"),
    ("2025-06-01T00:00:00Z", "2025-06-30T23:59:59Z", "Junio 2025"),
    ("2025-07-01T00:00:00Z", "2025-07-31T23:59:59Z", "Julio 2025"),
    ("2025-08-01T00:00:00Z", "2025-08-31T23:59:59Z", "Agosto 2025"),
    ("2025-09-01T00:00:00Z", "2025-09-30T23:59:59Z", "Septiembre 2025"),
    ("2025-10-01T00:00:00Z", "2025-10-31T23:59:59Z", "Octubre 2025"),
    ("2025-11-01T00:00:00Z", "2025-11-30T23:59:59Z", "Noviembre 2025"),
    ("2025-12-01T00:00:00Z", "2025-12-31T23:59:59Z", "Diciembre 2025"),
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
            doc_res = requests.get(
                f"{base_url}/reports/2021-06-30/documents/{doc_id}",
                headers={"x-amz-access-token": token},
            ).json()
            doc_url = doc_res["url"]
            comp = doc_res.get("compressionAlgorithm")
            
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
    print("🚀 EXTRAYENDO VENTAS HISTÓRICAS DE 2025 (SP-API REPORTS)")
    print("=" * 80)

    all_rows = []
    seen_keys = set()

    for start_time, end_time, label in MONTHS_2025:
        rows = request_and_download_report(start_time, end_time, label)
        for r in rows:
            unique_key = r.get("order-item-id") or (r.get("amazon-order-id", "") + "_" + r.get("sku", ""))
            if unique_key not in seen_keys:
                seen_keys.add(unique_key)
                all_rows.append(r)
        time.sleep(2)

    if not all_rows:
        print("❌ No se obtuvieron registros de ventas para 2025.")
        return

    output_csv = "ventas_2025.csv"
    fieldnames = list(all_rows[0].keys())
    with open(output_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(all_rows)

    print("\n" + "=" * 80)
    print(f"💾 Archivo guardado con éxito: {output_csv} ({len(all_rows)} líneas)")
    print("=" * 80)

if __name__ == "__main__":
    main()
