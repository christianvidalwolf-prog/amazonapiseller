import os
import sys
import time
import gzip
import csv
import requests
from auth import get_access_token, get_base_url

DEFAULT_MARKETPLACE_ID = "A1RKKUPIHCS9HS"

def get_report_rows_by_doc_id(doc_id):
    token = get_access_token()
    base_url = get_base_url()
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
        return []
    
    headers = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) == len(headers):
            rows.append(dict(zip(headers, parts)))
    return rows

def request_and_download_report(start_time, end_time, label):
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
    
    for attempt in range(5):
        res = requests.post(
            url_report,
            headers={"x-amz-access-token": token, "Content-Type": "application/json"},
            json=payload,
        )
        if res.status_code == 202:
            break
        elif res.status_code == 429:
            print("   ⚠️ Límite de tasa (429). Esperando 12s...")
            time.sleep(12)
        else:
            print(f"❌ Error al solicitar reporte ({res.status_code}): {res.text}")
            return []
    else:
        return []

    report_id = res.json().get("reportId")
    print(f"   Reporte en cola (ID: {report_id}). Esperando generación...")

    for _ in range(60):
        time.sleep(4)
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
            rows = get_report_rows_by_doc_id(doc_id)
            print(f"   ✅ {label}: {len(rows)} filas descargadas.")
            return rows
        elif status in ["FATAL", "CANCELLED"]:
            print(f"   ❌ Terminado con estado {status}: {data}")
            return []
            
    print(f"   ⚠️ Tiempo de espera agotado para {label}.")
    return []

def main():
    print("=" * 80)
    print("🔄 ACTUALIZACIÓN COMPLETA DE VENTAS 2025 (SEPTIEMBRE - DICIEMBRE)")
    print("=" * 80)

    # 1. Cargar datos existentes hasta 31 de Agosto de 2025
    existing_rows = []
    headers = None
    backup_file = "ventas_2025.csv.bak" if os.path.exists("ventas_2025.csv.bak") else "ventas_2025.csv"
    
    with open(backup_file, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=";")
        headers = reader.fieldnames
        for r in reader:
            p_date = r.get("purchase-date", "")
            if p_date < "2025-09-01T00:00:00":
                existing_rows.append(r)
                
    print(f"📦 Registros previos (Ene - Ago 2025): {len(existing_rows)} filas.")

    all_rows = []
    seen_keys = set()

    for r in existing_rows:
        k = r.get("order-item-id") or (r.get("amazon-order-id", "") + "_" + r.get("sku", ""))
        if k not in seen_keys:
            seen_keys.add(k)
            all_rows.append(r)

    # 2. Descargar Septiembre 2025 usando el documento ya generado
    print("\n📦 Procesando Septiembre 2025 (Documento existente)...")
    sept_doc_id = "amzn1.spdoc.1.4.eu.2a2f03a1-6f72-43df-ac20-b835049af084.T1AG435H7EWWOS.2409"
    try:
        sept_rows = get_report_rows_by_doc_id(sept_doc_id)
    except Exception as e:
        print("   Re-solicitando Septiembre 2025...")
        sept_rows = request_and_download_report("2025-09-01T00:00:00Z", "2025-09-30T23:59:59Z", "Septiembre 2025")

    for r in sept_rows:
        k = r.get("order-item-id") or (r.get("amazon-order-id", "") + "_" + r.get("sku", ""))
        if k not in seen_keys:
            seen_keys.add(k)
            all_rows.append(r)
    print(f"   ✅ Septiembre agregado. Total acumulado: {len(all_rows)} filas.")

    # 3. Solicitar Octubre, Noviembre, Diciembre 2025
    remaining_months = [
        ("2025-10-01T00:00:00Z", "2025-10-31T23:59:59Z", "Octubre 2025"),
        ("2025-11-01T00:00:00Z", "2025-11-30T23:59:59Z", "Noviembre 2025"),
        ("2025-12-01T00:00:00Z", "2025-12-31T23:59:59Z", "Diciembre 2025"),
    ]

    for start_time, end_time, label in remaining_months:
        print(f"\n📦 Procesando {label}...")
        rows = request_and_download_report(start_time, end_time, label)
        for r in rows:
            k = r.get("order-item-id") or (r.get("amazon-order-id", "") + "_" + r.get("sku", ""))
            if k not in seen_keys:
                seen_keys.add(k)
                all_rows.append(r)
        print(f"   Total acumulado: {len(all_rows)} filas.")
        time.sleep(3)

    # 4. Ordenar por purchase-date descendente
    all_rows.sort(key=lambda x: x.get("purchase-date", ""), reverse=True)

    # 5. Guardar en ventas_2025.csv
    output_file = "ventas_2025.csv"
    with open(output_file, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=headers, delimiter=";")
        writer.writeheader()
        writer.writerows(all_rows)

    print("\n" + "=" * 80)
    print(f"🎉 COMPLETADO: {output_file} actualizado con {len(all_rows)} filas.")
    print(f"   Fecha más reciente: {all_rows[0].get('purchase-date')}")
    print(f"   Fecha más antigua:  {all_rows[-1].get('purchase-date')}")
    print("=" * 80)

if __name__ == "__main__":
    main()
