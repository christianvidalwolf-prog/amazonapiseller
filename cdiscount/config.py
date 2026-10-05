"""
Configuración central para la integración con Cdiscount API
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class CdiscountAPIConfig:
    """Configuración de autenticación y endpoints de Cdiscount"""
    
    # Credenciales API
    CLIENT_ID: str = os.getenv("CDISCOUNT_CLIENT_ID", "")
    CLIENT_SECRET: str = os.getenv("CDISCOUNT_CLIENT_SECRET", "")
    API_KEY: str = os.getenv("CDISCOUNT_API_KEY", "")
    
    # Endpoints (Sandbox vs Producción)
    IS_SANDBOX: bool = os.getenv("CDISCOUNT_SANDBOX", "false").lower() == "true"
    
    @property
    def base_url(self) -> str:
        if self.IS_SANDBOX:
            return "https://api-sandbox.cdiscount.com"
        return "https://api.cdiscount.com"
    
    @property
    def auth_url(self) -> str:
        return f"{self.base_url}/OpenApi/authentication"
    
    @property
    def products_url(self) -> str:
        return f"{self.base_url}/OpenApi/products"
    
    @property
    def offers_url(self) -> str:
        return f"{self.base_url}/OpenApi/offers"
    
    @property
    def orders_url(self) -> str:
        return f"{self.base_url}/OpenApi/orders"
    
    # Rate Limiting Configuration
    RATE_LIMIT_REQUESTS: int = 10  # Requests por segundo
    RATE_LIMIT_BURST: int = 20    # Máximo burst
    REQUEST_TIMEOUT: int = 30    # Timeout en segundos
    
    # Retry Configuration
    MAX_RETRIES: int = 5
    RETRY_BACKOFF_BASE: float = 2.0  # Base de backoff exponencial
    RETRY_MAX_DELAY: float = 60.0  # Máximo delay entre reintentos
    
    # Lotes
    BATCH_SIZE: int = 50  # Productos por lote (según tu requerimiento)
    PRODUCTS_PER_HOUR: int = 50  # Meta: 50 productos/hora


@dataclass
class CdiscountProductConfig:
    """Configuración para creación de productos"""
    
    # Mapeo de categorías (ejemplo - personalizar según tu catálogo)
    CATEGORY_MAPPING: Dict[str, str] = field(default_factory=lambda: {
        "Electrónica": "10",
        "Hogar": "20", 
        "Deportes": "30",
        "Moda": "40",
        "Juguetes": "50",
    })
    
    # Atributos obligatorios por categoría
    REQUIRED_ATTRIBUTES: Dict[str, List[str]] = field(default_factory=lambda: {
        "10": ["Ean", "Name", "Brand", "Description", "Price", "Stock"],
        "20": ["Ean", "Name", "Brand", "Description", "Price", "Stock", "Color"],
        "30": ["Ean", "Name", "Brand", "Description", "Price", "Stock", "Size"],
    })
    
    # Configuración de precios
    DEFAULT_PRICE_MARKUP: float = 1.30  # 30% markup
    MIN_PRICE: float = 5.0
    MAX_PRICE: float = 5000.0
    
    # Configuración de stock
    MIN_STOCK: int = 1
    MAX_STOCK: int = 9999
    DEFAULT_STOCK: int = 10


@dataclass
class CdiscountMonitoringConfig:
    """Configuración de monitoreo"""
    
    # Logging
    LOG_DIR: str = "/Users/christianvidalwolf/orca/amazonapiseller/cdiscount/logs"
    LOG_LEVEL: str = "INFO"  # DEBUG, INFO, WARNING, ERROR
    LOG_FILE: str = "cdiscount_creation.log"
    ERROR_LOG_FILE: str = "cdiscount_errors.log"
    
    # Métricas
    METRICS_FILE: str = "cdiscount_metrics.json"
    
    # Alertas
    ALERT_EMAIL: Optional[str] = None
    ALERT_THRESHOLD_ERRORS: int = 10  # Alertar después de N errores


# Instancia global de configuración
config = CdiscountAPIConfig()
product_config = CdiscountProductConfig()
monitoring_config = CdiscountMonitoringConfig()


def load_from_env():
    """Recargar configuración desde variables de entorno"""
    global config, product_config, monitoring_config
    config = CdiscountAPIConfig()
    product_config = CdiscountProductConfig()
    monitoring_config = CdiscountMonitoringConfig()


def validate_config() -> bool:
    """Validar que la configuración es correcta"""
    errors = []
    
    if not config.CLIENT_ID:
        errors.append("CDISCOUNT_CLIENT_ID no configurado")
    if not config.CLIENT_SECRET:
        errors.append("CDISCOUNT_CLIENT_SECRET no configurado")
    if not config.API_KEY:
        errors.append("CDISCOUNT_API_KEY no configurado")
    
    if errors:
        print("❌ Errores de configuración:")
        for error in errors:
            print(f"   - {error}")
        return False
    
    return True
