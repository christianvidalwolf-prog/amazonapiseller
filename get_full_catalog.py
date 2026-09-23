#!/usr/bin/env python3
"""
Descarga el catálogo completo de Seller Central (FBA + FBM + Inactivos + Activos)
usando el reporte oficial GET_MERCHANT_LISTINGS_ALL_DATA de Amazon SP-API.
"""

import os
import sys
import time
import gzip
import csv
from datetime import datetime
import requests
from auth import get_access_token, get_base_url

MARKETPLACE_ID = os.getenv("SP_API_MARKETPLACE_IDS", "A1RKKUPIHCS9HS").split(",")[0].strip()
OUTPUT_FILE = "catalogo_completo.csv"


def log(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}")


def download_full_catalog():
    token = get_access_token()
    base_url = get_base_url()

    url_report = f"{base_url}/reports/2021-06-30/reports"
    payload = {
        "reportType": "GET_MERCHANT_LISTINGS_ALL_DATA",
        "marketplaceIds": [MARKETPLACE_ID],
    }

    log("Solicitando informe maestro GET_MERCHANT_LISTINGS_ALL_DATA a Amazon...")
    res = requests.post(
        url_report,
        headers={"x-amz-access-token": token, "Content-Type": "application/json"},
        json=payload,
    )

    if res.status_code != 202:
        log(f"❌ Error al solicitar reporte ({res.status_code}): {res.text}")
        return False

    report_id = res.json().get("reportId")
    log(f"   Reporte en cola (ID: {report_id}). Esperando generación en Amazon...")

    # Sondeo
    doc_id = None
    for attempt in range(60):
        time.sleep(4)
        curr_token = get_access_token()
        status_res = requests.get(
            f"{base_url}/reports/2021-06-30/reports/{report_id}",
            headers={"x-amz-access-token": curr_token},
        )
        if status_res.status_code != 200:
            continue
        data = status_res.json()
        status = data.get("processingStatus")
        log(f"   Estado del reporte (intento {attempt+1}): {status}")

        if status == "DONE":
            doc_id = data.get("reportDocumentId")
            break
        elif status in ["FATAL", "CANCELLED"]:
            log(f"❌ El reporte falló con estado {status}: {data}")
            return False

    if not doc_id:
        log("❌ Tiempo de espera agotado esperando el reporte.")
        return False

    # Descargar documento
    log(f"Descargando documento de catálogo (ID: {doc_id})...")
    doc_res = requests.get(
        f"{base_url}/reports/2021-06-30/documents/{doc_id}",
        headers={"x-amz-access-token": get_access_token()},
    )
    doc_data = doc_res.json()
    download_url = doc_data.get("url")
    is_gzip = doc_data.get("compressionAlgorithm") == "GZIP"

    raw = requests.get(download_url).content
    if is_gzip:
        raw = gzip.decompress(raw)

    text = raw.decode("latin1", errors="replace")
    lines = text.splitlines()

    if len(lines) <= 1:
        log("⚠️ El catálogo está vacío.")
        return False

    log(f"✅ Descarga finalizada: {len(lines) - 1} productos encontrados en Amazon.")

    # Guardar en catalogo_completo.csv estructurado en delimitador ;
    headers = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) == len(headers):
            rows.append(dict(zip(headers, parts)))

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8-sig") as f:
        # Normalizamos nombres de cabeceras relevantes
        writer = csv.DictWriter(f, fieldnames=headers, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)

    log(f"💾 Guardado con éxito en '{OUTPUT_FILE}' ({len(rows)} productos).")
    return True


if __name__ == "__main__":
    download_full_catalog()
