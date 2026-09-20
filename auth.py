import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()

LWA_CLIENT_ID = os.getenv("LWA_CLIENT_ID", "").strip()
LWA_CLIENT_SECRET = os.getenv("LWA_CLIENT_SECRET", "").strip()
SP_API_REFRESH_TOKEN = os.getenv("SP_API_REFRESH_TOKEN", "").strip()
SP_API_REGION = os.getenv("SP_API_REGION", "EU").strip().upper()

REGIONS = {
    "EU": "https://sellingpartnerapi-eu.amazon.com",
    "NA": "https://sellingpartnerapi-na.amazon.com",
    "FE": "https://sellingpartnerapi-fe.amazon.com",
}

# Cache en memoria para reutilizar el token durante su validez (3600s)
_token_cache = {
    "access_token": None,
    "expires_at": 0
}

def get_access_token():
    """Devuelve un token LWA válido, renovándolo automáticamente si ha caducado."""
    now = time.time()
    if _token_cache["access_token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["access_token"]

    url = "https://api.amazon.com/auth/o2/token"
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": SP_API_REFRESH_TOKEN,
        "client_id": LWA_CLIENT_ID,
        "client_secret": LWA_CLIENT_SECRET,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    response = requests.post(url, data=payload, headers=headers)
    if response.status_code != 200:
        raise RuntimeError(f"Error al autenticar con LWA ({response.status_code}): {response.text}")

    data = response.json()
    token = data["access_token"]
    expires_in = data.get("expires_in", 3600)

    _token_cache["access_token"] = token
    _token_cache["expires_at"] = now + expires_in
    return token

def get_base_url():
    return REGIONS.get(SP_API_REGION, REGIONS["EU"])
