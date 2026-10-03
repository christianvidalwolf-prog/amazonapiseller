import os
import time
import requests
import re
from urllib.parse import urlparse, parse_qs
from dotenv import load_dotenv

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), "backend", ".env"))

CLIENT_ID = os.getenv("CDISCOUNT_CLIENT_ID")
CLIENT_SECRET = os.getenv("CDISCOUNT_CLIENT_SECRET")
SELLER_ID = os.getenv("CDISCOUNT_SELLER_ID", "9891")
SALES_CHANNEL_ID = os.getenv("CDISCOUNT_SALES_CHANNEL_ID", "CDISFR")

TOKEN_URL = "https://auth.octopia.com/auth/realms/maas/protocol/openid-connect/token"
API_BASE_URL = "https://api.octopia-io.net/seller/v2"

class CdiscountClient:
    def __init__(self):
        self.seller_id = str(SELLER_ID)
        self.sales_channel_id = str(SALES_CHANNEL_ID)
        self.access_token = None
        self.token_expiry = 0

    def get_token(self) -> str:
        # Renovar si expira en menos de 60 segundos
        if self.access_token and time.time() < (self.token_expiry - 60):
            return self.access_token

        payload = {
            "grant_type": "client_credentials",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET
        }
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        res = requests.post(TOKEN_URL, data=payload, headers=headers, timeout=20)
        res.raise_for_status()
        data = res.json()
        self.access_token = data.get("access_token")
        expires_in = data.get("expires_in", 7200)
        self.token_expiry = time.time() + expires_in
        return self.access_token

    def get_headers(self, accept_language: str = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self.get_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "SellerId": self.seller_id,
            "SalesChannelId": self.sales_channel_id
        }
        if accept_language:
            headers["Accept-Language"] = accept_language
        return headers

    def get_existing_offers(self, limit_pages: int = None) -> dict:
        """Descarga todas las ofertas existentes de Cdiscount usando cursor pagination."""
        offers = {}
        cursor = None
        page = 1
        url = f"{API_BASE_URL}/offers"
        headers = self.get_headers()

        while True:
            params = {"salesChannelId": self.sales_channel_id, "limit": 1000}
            if cursor:
                params["cursor"] = cursor

            res = requests.get(url, headers=headers, params=params, timeout=30)
            if res.status_code != 200:
                print(f"❌ Error al consultar ofertas (página {page}): {res.status_code} - {res.text[:200]}")
                break

            data = res.json()
            items = data.get("items", [])
            if not items:
                break

            for it in items:
                sku = it.get("sellerExternalReference")
                gtin = it.get("product", {}).get("gtin")
                if sku:
                    offers[sku] = {
                        "sku": sku,
                        "gtin": gtin,
                        "state": it.get("offerState"),
                        "price": it.get("facialPrice", {}).get("price")
                    }

            print(f"  📥 Ofertas Cdiscount descargadas: {len(offers)} (Página {page})")

            # Cursor en header Link
            link_header = res.headers.get("Link")
            next_cursor = None
            if link_header:
                matches = re.findall(r'<([^>]+)>;\s*rel="([^"]+)"', link_header)
                for url_part, rel in matches:
                    if rel == "next":
                        parsed = urlparse(url_part)
                        qs = parse_qs(parsed.query)
                        cursor_val = qs.get("Cursor") or qs.get("cursor")
                        if cursor_val:
                            next_cursor = cursor_val[0]

            if not next_cursor or next_cursor == cursor:
                break
            if limit_pages and page >= limit_pages:
                break

            cursor = next_cursor
            page += 1
            time.sleep(0.3)

        return offers

    def create_offer_package(self, package_type: str = "Upsert") -> str:
        """Crea un nuevo paquete de ofertas y devuelve su packageId."""
        url = f"{API_BASE_URL}/offer-packages"
        headers = self.get_headers()
        body = {"PackageType": package_type}

        res = requests.post(url, headers=headers, json=body, timeout=15)
        if res.status_code != 201:
            raise Exception(f"Error al crear paquete ({res.status_code}): {res.text}")

        content_loc = res.headers.get("content-location")
        if not content_loc:
            raise Exception("No se recibió content-location en la respuesta del paquete.")
        package_id = content_loc.split("/")[-1]
        return package_id

    def upload_offer_requests(self, package_id: str, offers: list) -> bool:
        """Sube una lista de ofertas al paquete."""
        url = f"{API_BASE_URL}/offer-packages/{package_id}/offer-requests"
        headers = self.get_headers()

        payload = []
        for o in offers:
            payload.append({
                "sellerExternalReference": o["sku"],
                "product": {
                    "gtin": o["ean"]
                },
                "condition": "New",
                "price": {
                    "price": round(float(o["price"]), 2),
                    "currencyCode": "EUR",
                    "taxes": [
                        {"code": "vat", "type": "Rate", "value": 0.2},
                        {"code": "ecoTax", "type": "Amount", "value": 0.0},
                        {"code": "deaTax", "type": "Amount", "value": 0.0}
                    ]
                },
                "quantity": int(o["stock"]),
                "preparationTime": 2,
                "deliveryModes": [
                    {
                        "code": "THD",
                        "cost": 4.99,
                        "additionalCost": 0.0
                    },
                    {
                        "code": "NTHD",
                        "cost": 4.99,
                        "additionalCost": 0.0
                    }
                ]
            })

        res = requests.post(url, headers=headers, json=payload, timeout=30)
        if res.status_code in [200, 201, 202, 204]:
            return True
        print(f"❌ Error al subir ofertas al paquete {package_id}: {res.status_code} - {res.text}")
        return False

    def finalize_offer_package(self, package_id: str) -> bool:
        """Marca el paquete como Ready para que Cdiscount lo procese."""
        url = f"{API_BASE_URL}/offer-packages/{package_id}"
        headers = self.get_headers()
        res = requests.patch(url, headers=headers, json={"State": "Ready"}, timeout=15)
        return res.status_code in [200, 204]

    def wait_for_offer_package_results(self, package_id: str, max_wait_sec: int = 180) -> list:
        """Espera a que el paquete se integre y devuelve el array de items procesados/rechazados."""
        url_status = f"{API_BASE_URL}/offer-packages/{package_id}"
        url_results = f"{API_BASE_URL}/offer-packages/{package_id}/offer-requests-results"
        headers = self.get_headers()

        start_time = time.time()
        print(f"  ⏳ Esperando integración del paquete {package_id} en Cdiscount...")

        while time.time() - start_time < max_wait_sec:
            time.sleep(10)
            res = requests.get(url_status, headers=headers, timeout=15)
            if res.status_code == 200:
                state = res.json().get("state")
                if state == "Integrated":
                    # Obtener resultados
                    res_results = requests.get(url_results, headers=headers, timeout=20)
                    if res_results.status_code == 200:
                        return res_results.json().get("items", [])
                elif state in ["Rejected", "Error"]:
                    print(f"⚠️ Paquete terminado con estado: {state}")
                    return []

        print(f"⏱ Tiempo de espera superado para el paquete {package_id}")
        return []

    def create_products(self, products: list) -> str:
        """Envía fichas técnicas de productos en francés a Cdiscount / Octopia."""
        url = f"{API_BASE_URL}/products-integration"
        headers = self.get_headers(accept_language="fr-FR")

        payload = {"products": products}
        res = requests.post(url, headers=headers, json=payload, timeout=30)
        if res.status_code in [200, 202]:
            pkg_id = res.json().get("packageId")
            return pkg_id
        else:
            print(f"❌ Error al integrar productos ({res.status_code}): {res.text}")
            return None
