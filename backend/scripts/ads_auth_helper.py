#!/usr/bin/env python3
"""
Amazon Advertising API (PPC) Authorization Helper.

This interactive script:
1. Uses your existing LWA_CLIENT_ID & LWA_CLIENT_SECRET from backend/.env.
2. Generates the official Login with Amazon URL with the Advertising scope:
   `cpc_advertising:campaign_management`.
3. Intercambia el authorization code por el ADS_API_REFRESH_TOKEN.
4. Consulta tus perfiles de Amazon Ads en Europa (Amazon.es) para obtener tu profileId.
5. Guarda automáticamente las credenciales en backend/.env.
"""

import os
import sys
import json
import urllib.parse
import requests
from pathlib import Path

# Locate backend/.env
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
ENV_PATH = BACKEND_DIR / ".env"

def load_env_file(path: Path) -> dict:
    env_vars = {}
    if not path.exists():
        return env_vars
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                env_vars[key.strip()] = val.strip().strip("'").strip('"')
    return env_vars

def update_env_file(path: Path, updates: dict):
    lines = []
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()

    # Track which keys have been updated
    updated_keys = set()
    new_lines = []

    for line in lines:
        stripped = line.strip()
        matched = False
        for k, v in updates.items():
            if stripped.startswith(f"{k}=") or stripped == k:
                new_lines.append(f"{k}={v}\n")
                updated_keys.add(k)
                matched = True
                break
        if not matched:
            new_lines.append(line)

    # Append remaining new keys
    for k, v in updates.items():
        if k not in updated_keys:
            new_lines.append(f"{k}={v}\n")

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

def main():
    print("=" * 65)
    print("  AMAZON ADVERTISING API - ASISTENTE DE AUTORIZACIÓN (PPC)  ")
    print("=" * 65)
    print()

    env_vars = load_env_file(ENV_PATH)
    client_id = env_vars.get("ADS_API_CLIENT_ID") or env_vars.get("LWA_CLIENT_ID")
    client_secret = env_vars.get("ADS_API_CLIENT_SECRET") or env_vars.get("LWA_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("❌ Error: No se encontraron LWA_CLIENT_ID y LWA_CLIENT_SECRET en backend/.env.")
        print("Por favor, asegúrate de tener configurado tu backend/.env primero.")
        sys.exit(1)

    redirect_uri = "https://127.0.0.1" # Standard redirect uri in LWA Security Profile

    scope = "advertising::campaign_management"
    auth_params = {
        "client_id": client_id,
        "scope": scope,
        "response_type": "code",
        "redirect_uri": redirect_uri,
    }
    # Endpoint oficial de autorización LWA para Europa / España
    auth_url = f"https://eu.account.amazon.com/ap/oa?{urllib.parse.urlencode(auth_params)}"

    print("📌 PASO 1: Autorización en el navegador (Europa / España)")
    print("-" * 65)
    print("Abre el siguiente enlace oficial europeo de Amazon en tu navegador:")
    print()
    print(auth_url)
    print()
    print("👉 NOTA: Si en tu Security Profile (Amazon Developer Console) configuraste")
    print(f"otra 'Allowed Return URL' distinta de {redirect_uri}, avísanos para usarla.")
    print("-" * 65)
    print()
    print("📌 PASO 2: Pegar la URL de redirección o el código")
    print("-" * 65)
    print("Tras iniciar sesión con tu cuenta de Amazon Seller/Ads España y aprobar el acceso,")
    print("el navegador te redirigirá a una dirección que contendrá '?code=AN...'")
    print()
    
    redirect_input = input("Pega aquí la URL completa a la que te redirigió (o el valor de 'code'): ").strip()
    if not redirect_input:
        print("❌ Operación cancelada: No se proporcionó ningún código.")
        sys.exit(1)

    code = redirect_input
    if "code=" in redirect_input:
        parsed = urllib.parse.urlparse(redirect_input)
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get("code", [code])[0]

    print()
    print("⏳ Intercambiando código por refresh token en Amazon LWA Europa...")
    token_resp = requests.post(
        "https://api.amazon.co.uk/auth/o2/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )

    if token_resp.status_code != 200:
        print(f"❌ Error al canjear el código ({token_resp.status_code}): {token_resp.text}")
        sys.exit(1)

    token_data = token_resp.json()
    refresh_token = token_data.get("refresh_token")
    access_token = token_data.get("access_token")

    if not refresh_token:
        print("❌ Error: No se recibió refresh_token de Amazon.")
        sys.exit(1)

    print("✅ Refresh token de publicidad obtenido con éxito!")
    print()
    print("⏳ Consultando perfiles de anunciante en Amazon Ads Europa...")

    profile_id = None
    try:
        profiles_resp = requests.get(
            "https://advertising-api-eu.amazon.com/v2/profiles",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Amazon-Advertising-API-ClientId": client_id,
                "Content-Type": "application/json",
            },
            timeout=15,
        )
        if profiles_resp.status_code == 200:
            profiles = profiles_resp.json()
            print(f"✅ Se encontraron {len(profiles)} perfil(es) publicitario(s):")
            for idx, p in enumerate(profiles):
                p_id = p.get("profileId")
                country = p.get("countryCode", "??")
                name = p.get("accountInfo", {}).get("name", "Desconocido")
                print(f"   [{idx + 1}] ID: {p_id} | País: {country} | Nombre: {name}")
                if country == "ES" or not profile_id:
                    profile_id = str(p_id)
        else:
            print(f"⚠️ Nota al listar perfiles ({profiles_resp.status_code}): {profiles_resp.text}")
    except Exception as e:
        print(f"⚠️ Error conectando a Ads profiles: {e}")

    updates = {
        "ADS_API_REFRESH_TOKEN": refresh_token,
        "ADS_API_REGION": "EU",
    }
    if profile_id:
        updates["ADS_API_PROFILE_ID"] = profile_id

    print()
    print("=" * 65)
    print("💾 CONFIGURACIÓN GENERADA:")
    print("-" * 65)
    for k, v in updates.items():
        print(f"{k}={v}")
    print("-" * 65)

    save = input("¿Deseas guardar automáticamente estos valores en backend/.env? (s/n): ").strip().lower()
    if save in ("s", "si", "y", "yes"):
        update_env_file(ENV_PATH, updates)
        print("🎉 ¡Configuración guardada en backend/.env correctamente!")
    else:
        print("Puedes copiar los valores anteriores manualmente a tu backend/.env.")

if __name__ == "__main__":
    main()
