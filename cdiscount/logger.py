"""
Sistema de logging avanzado para Cdiscount
"""

import os
import json
import logging
from datetime import datetime
from typing import Any, Dict, Optional
from pathlib import Path

from .config import monitoring_config


class CdiscountLogger:
    """Logger personalizado para la integración con Cdiscount"""
    
    def __init__(self, name: str = "cdiscount"):
        self.name = name
        self.logger = logging.getLogger(name)
        self.logger.setLevel(getattr(logging, monitoring_config.LOG_LEVEL.upper(), logging.INFO))
        
        # Crear directorio de logs
        Path(monitoring_config.LOG_DIR).mkdir(parents=True, exist_ok=True)
        
        # Formato
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        # Handler para archivo principal
        log_file = os.path.join(monitoring_config.LOG_DIR, monitoring_config.LOG_FILE)
        file_handler = logging.FileHandler(log_file, encoding='utf-8')
        file_handler.setFormatter(formatter)
        self.logger.addHandler(file_handler)
        
        # Handler para errores
        error_file = os.path.join(monitoring_config.LOG_DIR, monitoring_config.ERROR_LOG_FILE)
        error_handler = logging.FileHandler(error_file, encoding='utf-8')
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(formatter)
        self.logger.addHandler(error_handler)
        
        # Handler para consola
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        self.logger.addHandler(console_handler)
        
        # Evitar duplicados
        self.logger.propagate = False
    
    def log_product_creation(self, sku: str, success: bool, 
                           marketplace: str = "ES", 
                           error: Optional[str] = None,
                           duration: Optional[float] = None,
                           extra: Dict[str, Any] = None) -> None:
        """Log específico para creación de productos"""
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "sku": sku,
            "marketplace": marketplace,
            "success": success,
            "duration_seconds": duration,
            "error": error,
            "extra": extra or {}
        }
        
        if success:
            self.logger.info(f"✅ Producto {sku} creado en {marketplace}", extra=log_entry)
        else:
            self.logger.error(f"❌ Error creando {sku} en {marketplace}: {error}", extra=log_entry)
        
        # Guardar en archivo JSON para análisis
        self._save_metric(log_entry)
    
    def log_batch_processing(self, batch_number: int, total_batches: int,
                           products_processed: int, products_created: int,
                           errors: int, duration: float) -> None:
        """Log para procesamiento por lotes"""
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "batch": batch_number,
            "total_batches": total_batches,
            "products_processed": products_processed,
            "products_created": products_created,
            "errors": errors,
            "duration_seconds": duration,
            "creation_rate": products_created / duration if duration > 0 else 0
        }
        
        self.logger.info(
            f"📦 Lote {batch_number}/{total_batches}: "
            f"{products_created} creados de {products_processed} procesados "
            f"({errors} errores) en {duration:.2f}s"
        )
        
        self._save_metric(log_entry, "batch")
    
    def log_api_call(self, endpoint: str, status_code: int, 
                   duration: float, request_id: Optional[str] = None) -> None:
        """Log para llamadas API"""
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "endpoint": endpoint,
            "status_code": status_code,
            "duration_seconds": duration,
            "request_id": request_id
        }
        
        if status_code >= 400:
            self.logger.warning(f"⚠️ API {endpoint}: {status_code} ({duration:.3f}s)")
        else:
            self.logger.debug(f"🔄 API {endpoint}: {status_code} ({duration:.3f}s)")
    
    def log_rate_limit(self, endpoint: str, retry_after: int) -> None:
        """Log para rate limiting"""
        self.logger.warning(
            f"⏳ Rate limit en {endpoint}. Esperando {retry_after}s"
        )
    
    def _save_metric(self, data: Dict[str, Any], metric_type: str = "product") -> None:
        """Guardar métrica en archivo JSON"""
        try:
            metrics_file = os.path.join(
                monitoring_config.LOG_DIR, 
                f"{metric_type}_{monitoring_config.METRICS_FILE}"
            )
            
            # Leer existentes
            existing_metrics = []
            if os.path.exists(metrics_file):
                try:
                    with open(metrics_file, 'r', encoding='utf-8') as f:
                        existing_metrics = json.load(f)
                except (json.JSONDecodeError, IOError):
                    existing_metrics = []
            
            existing_metrics.append(data)
            
            # Guardar
            with open(metrics_file, 'w', encoding='utf-8') as f:
                json.dump(existing_metrics, f, indent=2, ensure_ascii=False)
            
            # Limpiar si es muy grande
            if len(existing_metrics) > 10000:
                # Mantener últimos 5000
                with open(metrics_file, 'w', encoding='utf-8') as f:
                    json.dump(existing_metrics[-5000:], f, indent=2, ensure_ascii=False)
        except Exception as e:
            self.logger.error(f"Error guardando métrica: {e}")


# Instancia global
logger = CdiscountLogger()


def get_logger(name: Optional[str] = None) -> CdiscountLogger:
    """Obtener logger (opcionalmente con nombre específico)"""
    return CdiscountLogger(name or "cdiscount")
