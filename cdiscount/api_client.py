"""
Cliente API de Cdiscount con manejo de rate limiting y errores
"""

import os
import time
import json
import requests
from typing import Any, Dict, List, Optional, Tuple, Union
from dataclasses import dataclass

from .config import config
from .logger import logger


@dataclass
class APIResponse:
    """Respuesta estandarizada de la API"""
    success: bool
    status_code: int
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    retry_after: Optional[int] = None
    request_id: Optional[str] = None
    
    def __str__(self) -> str:
        if self.success:
            return f"✅ APIResponse: {self.status_code}"
        return f"❌ APIResponse: {self.status_code} - {self.error}"


class CdiscountAPIClient:
    """
    Cliente robusto para la API de Cdiscount con:
    - Autenticación OAuth2
    - Rate limiting automático
    - Retry con backoff exponencial
    - Logging detallado
    - Validación de respuestas
    """
    
    def __init__(self):
        self.base_url = config.base_url
        self.auth_token: Optional[str] = None
        self.token_expiry: Optional[float] = None
        self.request_count: int = 0
        self.last_request_time: float = 0
        self.min_request_interval: float = 1.0 / max(config.RATE_LIMIT_REQUESTS, 1)
        
        # Inicializar token
        self._authenticate()
    
    def _authenticate(self) -> bool:
        """Autenticarse y obtener token OAuth2"""
        try:
            # Cdiscount usa autenticación básica + API key en headers
            auth = (config.CLIENT_ID, config.CLIENT_SECRET)
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Api-Token": config.API_KEY
            }
            
            # La autenticación de Cdiscount es diferente
            # Usan un token estático o OAuth2 según configuración
            # Para simplificar, asumimos API key en headers
            
            # Probar conexión
            test_url = f"{self.base_url}/OpenApi/authentication"
            response = requests.get(
                test_url,
                auth=auth,
                headers=headers,
                timeout=config.REQUEST_TIMEOUT
            )
            
            if response.status_code in [200, 201]:
                self.auth_token = config.API_KEY  # Para Cdiscount, el API key es el token
                self.token_expiry = time.time() + 3600  # 1 hora de validez
                logger.logger.info("✅ Autenticación Cdiscount exitosa")
                return True
            else:
                logger.logger.error(f"❌ Error de autenticación: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            logger.logger.error(f"❌ Error al autenticarse: {e}")
            return False
    
    def _ensure_authenticated(self) -> bool:
        """Asegurar que tenemos token válido"""
        if not self.auth_token:
            return self._authenticate()
        
        # Verificar si token expiración
        if self.token_expiry and time.time() > self.token_expiry - 300:  # 5 min antes
            logger.logger.info("🔄 Renovando token Cdiscount")
            return self._authenticate()
        
        return True
    
    def _wait_for_rate_limit(self) -> None:
        """Esperar para respetar rate limiting"""
        current_time = time.time()
        elapsed = current_time - self.last_request_time
        wait_time = max(0, self.min_request_interval - elapsed)
        
        if wait_time > 0:
            time.sleep(wait_time)
        
        self.last_request_time = time.time()
    
    def _make_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        retries: int = config.MAX_RETRIES,
        backoff_factor: float = config.RETRY_BACKOFF_BASE
    ) -> APIResponse:
        """Hacer request HTTP con retry y rate limiting"""
        
        # Esperar por rate limiting
        self._wait_for_rate_limit()
        
        # Asegurar autenticación
        if not self._ensure_authenticated():
            return APIResponse(
                success=False,
                status_code=401,
                error="Autenticación fallida"
            )
        
        # Configurar headers
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Api-Token": self.auth_token,
            "Client-Id": config.CLIENT_ID
        }
        
        # URL completa
        url = f"{self.base_url}{endpoint}"
        
        last_exception: Optional[Exception] = None
        
        for attempt in range(retries + 1):
            try:
                start_time = time.time()
                
                # Hacer request
                if method.upper() == "GET":
                    response = requests.get(
                        url, 
                        headers=headers, 
                        params=params,
                        timeout=config.REQUEST_TIMEOUT
                    )
                elif method.upper() == "POST":
                    response = requests.post(
                        url,
                        headers=headers,
                        json=json_data or data,
                        timeout=config.REQUEST_TIMEOUT
                    )
                elif method.upper() == "PUT":
                    response = requests.put(
                        url,
                        headers=headers,
                        json=json_data or data,
                        timeout=config.REQUEST_TIMEOUT
                    )
                elif method.upper() == "PATCH":
                    response = requests.patch(
                        url,
                        headers=headers,
                        json=json_data or data,
                        timeout=config.REQUEST_TIMEOUT
                    )
                elif method.upper() == "DELETE":
                    response = requests.delete(
                        url,
                        headers=headers,
                        timeout=config.REQUEST_TIMEOUT
                    )
                else:
                    return APIResponse(
                        success=False,
                        status_code=400,
                        error=f"Método {method} no soportado"
                    )
                
                duration = time.time() - start_time
                request_id = response.headers.get("X-Request-Id") or response.headers.get("Request-Id")
                
                # Loguear llamada API
                logger.log_api_call(endpoint, response.status_code, duration, request_id)
                
                # Procesar respuesta
                if response.status_code in [200, 201, 204]:
                    try:
                        json_data = response.json() if response.content else {}
                    except json.JSONDecodeError:
                        json_data = {}
                    
                    return APIResponse(
                        success=True,
                        status_code=response.status_code,
                        data=json_data,
                        request_id=request_id
                    )
                
                # Manejar rate limiting (429)
                elif response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", backoff_factor ** attempt))
                    logger.log_rate_limit(endpoint, retry_after)
                    time.sleep(retry_after)
                    continue
                
                # Otros errores
                else:
                    try:
                        error_msg = response.json().get("message") or response.text
                    except Exception:
                        error_msg = response.text
                    
                    # No reintentar en errores de validación (400)
                    if response.status_code == 400:
                        return APIResponse(
                            success=False,
                            status_code=response.status_code,
                            error=error_msg,
                            request_id=request_id
                        )
                    
                    # Esperar antes de reintentar
                    delay = min(backoff_factor ** attempt, config.RETRY_MAX_DELAY)
                    logger.logger.warning(
                        f"⚠️ Intento {attempt + 1}/{retries + 1} - "
                        f"{method} {endpoint}: {response.status_code} - "
                        f"Esperando {delay:.1f}s"
                    )
                    time.sleep(delay)
                    last_exception = Exception(f"HTTP {response.status_code}: {error_msg}")
                
            except requests.exceptions.Timeout:
                delay = min(backoff_factor ** attempt, config.RETRY_MAX_DELAY)
                logger.logger.warning(f"⏰ Timeout en {endpoint} - Esperando {delay:.1f}s")
                time.sleep(delay)
                last_exception = Exception("Request timeout")
                
            except requests.exceptions.ConnectionError as e:
                delay = min(backoff_factor ** attempt, config.RETRY_MAX_DELAY)
                logger.logger.warning(f"🌐 Error de conexión: {e} - Esperando {delay:.1f}s")
                time.sleep(delay)
                last_exception = e
                
            except Exception as e:
                logger.logger.error(f"❌ Error inesperado: {e}")
                last_exception = e
                break
        
        # Si llegamos aquí, todos los reintentos fallaron
        return APIResponse(
            success=False,
            status_code=0,
            error=f"Excedido límite de reintentos ({retries}): {last_exception}" if last_exception else "Error desconocido"
        )
    
    def get(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> APIResponse:
        """GET request"""
        return self._make_request("GET", endpoint, params=params)
    
    def post(self, endpoint: str, data: Optional[Dict[str, Any]] = None) -> APIResponse:
        """POST request"""
        return self._make_request("POST", endpoint, json_data=data)
    
    def put(self, endpoint: str, data: Optional[Dict[str, Any]] = None) -> APIResponse:
        """PUT request"""
        return self._make_request("PUT", endpoint, json_data=data)
    
    def patch(self, endpoint: str, data: Optional[Dict[str, Any]] = None) -> APIResponse:
        """PATCH request"""
        return self._make_request("PATCH", endpoint, json_data=data)
    
    def delete(self, endpoint: str) -> APIResponse:
        """DELETE request"""
        return self._make_request("DELETE", endpoint)
    
    # Métodos específicos de Cdiscount
    
    def get_product(self, sku: str) -> APIResponse:
        """Obtener información de un producto"""
        endpoint = f"/products/{sku}"
        return self.get(endpoint)
    
    def create_product(self, product_data: Dict[str, Any]) -> APIResponse:
        """Crear un nuevo producto"""
        endpoint = "/products"
        return self.post(endpoint, data=product_data)
    
    def update_product(self, sku: str, product_data: Dict[str, Any]) -> APIResponse:
        """Actualizar un producto"""
        endpoint = f"/products/{sku}"
        return self.put(endpoint, data=product_data)
    
    def create_offer(self, offer_data: Dict[str, Any]) -> APIResponse:
        """Crear una oferta"""
        endpoint = "/offers"
        return self.post(endpoint, data=offer_data)
    
    def update_offer(self, offer_id: str, offer_data: Dict[str, Any]) -> APIResponse:
        """Actualizar una oferta"""
        endpoint = f"/offers/{offer_id}"
        return self.put(endpoint, data=offer_data)
    
    def get_product_list(self, 
                        category_id: Optional[str] = None,
                        page: int = 1,
                        page_size: int = 100) -> APIResponse:
        """Listar productos"""
        params = {"page": page, "pageSize": page_size}
        if category_id:
            params["categoryId"] = category_id
        return self.get("/products", params=params)
    
    def search_products(self, query: str, page: int = 1, page_size: int = 50) -> APIResponse:
        """Buscar productos"""
        params = {"query": query, "page": page, "pageSize": page_size}
        return self.get("/products/search", params=params)
    
    def get_categories(self) -> APIResponse:
        """Obtener lista de categorías"""
        return self.get("/categories")
    
    def get_category_attributes(self, category_id: str) -> APIResponse:
        """Obtener atributos requeridos para una categoría"""
        return self.get(f"/categories/{category_id}/attributes")


# Instancia global
api_client = None


def get_api_client() -> CdiscountAPIClient:
    """Obtener instancia del cliente API"""
    global api_client
    if api_client is None:
        api_client = CdiscountAPIClient()
    return api_client


def reset_api_client():
    """Reiniciar cliente API"""
    global api_client
    api_client = None
