import os
import sys
import json
import requests
from dotenv import load_dotenv

# Cargar variables de entorno desde .env
load_dotenv()

LWA_CLIENT_ID = os.getenv("LWA_CLIENT_ID", "").strip()
LWA_CLIENT_SECRET = os.getenv("LWA_CLIENT_SECRET", "").strip()
SP_API_REFRESH_TOKEN = os.getenv("SP_API_REFRESH_TOKEN", "").strip()
SP_API_REGION = os.getenv("SP_API_REGION", "EU").strip().upper()

# Endpoints por región
REGIONS = {
    "EU": "https://sellingpartnerapi-eu.amazon.com",
    "NA": "https://sellingpartnerapi-na.amazon.com",
    "FE": "https://sellingpartnerapi-fe.amazon.com",
}

def check_env():
    missing = []
    if not LWA_CLIENT_ID:
        missing.append("LWA_CLIENT_ID")
    if not LWA_CLIENT_SECRET:
        missing.append("LWA_CLIENT_SECRET")
    if not SP_API_REFRESH_TOKEN:
        missing.append("SP_API_REFRESH_TOKEN")

    if missing:
        print("\n❌ Faltan las siguientes variables en el archivo .env:")
        for var in missing:
            print(f"   - {var}")
        print("\nPor favor, completa los valores en el archivo .env antes de continuar.\n")
        return False
    return True

def get_lwa_access_token():
    """Intercambia el Refresh Token por un Access Token de LWA temporal."""
    url = "https://api.amazon.com/auth/o2/token"
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": SP_API_REFRESH_TOKEN,
        "client_id": LWA_CLIENT_ID,
        "client_secret": LWA_CLIENT_SECRET,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    print("🔑 Solicitando Access Token a Login with Amazon (LWA)...")
    response = requests.post(url, data=payload, headers=headers)

    if response.status_code != 200:
        print(f"❌ Error al autenticar con LWA (HTTP {response.status_code}):")
        print(response.text)
        return None

    data = response.json()
    access_token = data.get("access_token")
    expires_in = data.get("expires_in")
    print(f"✅ Autenticación LWA exitosa (Token válido por {expires_in} segundos).")
    return access_token

def test_sp_api(access_token):
    """Prueba una llamada a la API de Sellers para verificar marketplaces disponibles."""
    base_url = REGIONS.get(SP_API_REGION, REGIONS["EU"])
    endpoint = f"{base_url}/sellers/v1/marketplaceParticipations"
    headers = {
        "x-amz-access-token": access_token,
        "User-Agent": "SP-API-Client/1.0 (Language=Python)",
    }

    print(f"\n📡 Conectando con Amazon SP-API ({SP_API_REGION}: {base_url})...")
    response = requests.get(endpoint, headers=headers)

    if response.status_code != 200:
        print(f"❌ Error al consultar SP-API (HTTP {response.status_code}):")
        print(response.text)
        return False

    data = response.json()
    print("✅ ¡Conexión exitosa con Amazon SP-API!")
    print("\n📦 Marketplaces vinculados a esta cuenta:")
    participations = data.get("payload", [])
    for item in participations:
        marketplace = item.get("marketplace", {})
        participation = item.get("participation", {})
        name = marketplace.get("name")
        m_id = marketplace.get("id")
        country = marketplace.get("countryCode")
        has_seller = participation.get("hasSuspendedListings", False)
        print(f"   • [{country}] {name} (ID: {m_id}) - Suspendido: {has_seller}")

    return True

if __name__ == "__main__":
    print("=== TEST DE CONEXIÓN AMAZON SP-API ===")
    if not check_env():
        sys.exit(1)

    token = get_lwa_access_token()
    if not token:
        sys.exit(1)

    success = test_sp_api(token)
    if success:
        print("\n🎉 Todo está configurado correctamente para trabajar con la API.")
    else:
        sys.exit(1)
