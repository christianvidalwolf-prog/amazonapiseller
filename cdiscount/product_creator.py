"""
Creador masivo de productos para Cdiscount
Sistema robusto con:
- Procesamiento por lotes
- Rate limiting automático
- Validación de datos
- Logging detallado
- Manejo de errores
"""

import os
import time
import json
import csv
import pandas as pd
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import Path

from .config import config, product_config
from .logger import logger
from .api_client import get_api_client, APIResponse
from .validation import validate_product, fix_product


@dataclass
class ProductCreationResult:
    """Resultado de creación de un producto"""
    sku: str
    success: bool
    marketplace: str = "ES"
    product_id: Optional[str] = None
    error: Optional[str] = None
    validation_errors: List[str] = field(default_factory=list)
    creation_time: float = 0.0
    retry_count: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "sku": self.sku,
            "success": self.success,
            "marketplace": self.marketplace,
            "product_id": self.product_id,
            "error": self.error,
            "validation_errors": self.validation_errors,
            "creation_time": self.creation_time,
            "retry_count": self.retry_count
        }


@dataclass
class BatchResult:
    """Resultado de un lote de creación"""
    batch_number: int
    total_products: int
    processed: int = 0
    created: int = 0
    failed: int = 0
    skipped: int = 0
    start_time: float = 0.0
    end_time: float = 0.0
    errors: List[Dict[str, Any]] = field(default_factory=list)
    
    @property
    def duration(self) -> float:
        return self.end_time - self.start_time if self.end_time > 0 else 0
    
    @property
    def creation_rate(self) -> float:
        if self.duration <= 0:
            return 0
        return self.created / self.duration * 3600  # productos/hora
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "batch_number": self.batch_number,
            "total_products": self.total_products,
            "processed": self.processed,
            "created": self.created,
            "failed": self.failed,
            "skipped": self.skipped,
            "duration_seconds": self.duration,
            "creation_rate": self.creation_rate,
            "start_time": datetime.fromtimestamp(self.start_time).isoformat() if self.start_time else None,
            "end_time": datetime.fromtimestamp(self.end_time).isoformat() if self.end_time else None,
            "errors": self.errors
        }


class CdiscountProductCreator:
    """
    Creador masivo de productos para Cdiscount
    
    Características:
    - Crea productos en lotes configurables
    - Validación automática antes de enviar
    - Retry con backoff exponencial
    - Logging detallado
    - Control de progreso
    """
    
    def __init__(self):
        self.api_client = get_api_client()
        self.session_start = time.time()
        self.total_created = 0
        self.total_failed = 0
        self.total_skipped = 0
        self.session_errors = []
        
        # Contadores por hora
        self.hourly_stats = {}
    
    def create_product(self, product_data: Dict[str, Any], 
                     max_retries: int = 3) -> ProductCreationResult:
        """
        Crear un producto individual en Cdiscount
        """
        sku = product_data.get("Sku") or product_data.get("sku") or "UNKNOWN"
        start_time = time.time()
        
        result = ProductCreationResult(
            sku=sku,
            success=False,
            creation_time=0.0,
            retry_count=0
        )
        
        # Validar datos
        validation = validate_product(product_data)
        if not validation.is_valid:
            result.validation_errors = validation.errors + validation.missing_required
            result.error = "Validación fallida"
            logger.log_product_creation(sku, False, error=validation.errors[0] if validation.errors else "Datos inválidos")
            return result
        
        # Intentar corregir datos
        fixed_data = fix_product(product_data)
        
        # Adaptar datos al formato de Cdiscount
        cdiscount_data = self._adapt_to_cdiscount_format(fixed_data)
        
        # Intentar creación
        for attempt in range(max_retries + 1):
            api_response = self.api_client.create_product(cdiscount_data)
            
            if api_response.success:
                result.success = True
                result.product_id = str(api_response.data.get("ProductId") or 
                                       api_response.data.get("productId") or 
                                       api_response.data.get("id"))
                result.creation_time = time.time() - start_time
                result.retry_count = attempt
                
                logger.log_product_creation(
                    sku, 
                    True, 
                    duration=result.creation_time,
                    extra={"product_id": result.product_id}
                )
                return result
            
            # Manejar errores
            result.retry_count = attempt
            
            # No reintentar errores de validación (400)
            if api_response.status_code == 400:
                result.error = api_response.error or "Error de validación"
                break
            
            # Rate limiting - el cliente API ya maneja retry, pero registramos
            if api_response.status_code == 429:
                result.error = f"Rate limiting - Esperando {api_response.retry_after}s"
                logger.logger.warning(f"Rate limiting en SKU {sku} - Intento {attempt + 1}")
            else:
                result.error = api_response.error or f"HTTP {api_response.status_code}"
            
            # Esperar antes de reintentar
            if attempt < max_retries:
                delay = min(2 ** attempt, 30)  # Backoff exponencial, máx 30s
                time.sleep(delay)
        
        result.creation_time = time.time() - start_time
        logger.log_product_creation(sku, False, error=result.error)
        return result
    
    def create_products_batch(self, products: List[Dict[str, Any]],
                           batch_size: int = config.BATCH_SIZE,
                           max_retries: int = 3) -> BatchResult:
        """
        Crear productos en lotes
        """
        batch_start = time.time()
        
        result = BatchResult(
            batch_number=0,
            total_products=len(products),
            start_time=batch_start
        )
        
        # Procesar en lotes
        for i in range(0, len(products), batch_size):
            batch_slice = products[i:i + batch_size]
            result.batch_number = (i // batch_size) + 1
            
            for product in batch_slice:
                result.processed += 1
                
                creation_result = self.create_product(product, max_retries)
                
                if creation_result.success:
                    result.created += 1
                    self.total_created += 1
                else:
                    result.failed += 1
                    self.total_failed += 1
                    result.errors.append(creation_result.to_dict())
                
                # Small delay entre productos para evitar rate limiting
                time.sleep(0.2)
            
            # Delay más largo entre lotes
            if i + batch_size < len(products):
                logger.logger.info(
                    f"Lote {result.batch_number} completado: "
                    f"{result.created}/{len(batch_slice)} creados"
                )
                time.sleep(2)  # Esperar entre lotes
        
        result.end_time = time.time()
        logger.log_batch_processing(
            result.batch_number,
            result.batch_number,
            result.processed,
            result.created,
            result.failed,
            result.duration
        )
        
        return result
    
    def create_from_csv(self, csv_path: str, 
                       batch_size: int = config.BATCH_SIZE) -> BatchResult:
        """Crear productos desde archivo CSV"""
        products = self._load_products_from_csv(csv_path)
        return self.create_products_batch(products, batch_size)
    
    def create_from_excel(self, excel_path: str,
                         batch_size: int = config.BATCH_SIZE) -> BatchResult:
        """Crear productos desde archivo Excel"""
        products = self._load_products_from_excel(excel_path)
        return self.create_products_batch(products, batch_size)
    
    def create_from_database(self, query: Optional[str] = None,
                           batch_size: int = config.BATCH_SIZE) -> BatchResult:
        """Crear productos desde base de datos (implementación pendiente)"""
        # Por ahora, simulamos
        products = []
        return self.create_products_batch(products, batch_size)
    
    def run_continuous_creation(self, 
                              source: str, 
                              source_path: str, 
                              batch_size: int = config.BATCH_SIZE,
                              products_per_hour: int = config.PRODUCTS_PER_HOUR) -> None:
        """
        Ejecutar creación continua respetando el límite de productos/hora
        """
        logger.logger.info(f"🚀 Iniciando creación continua desde {source}")
        logger.logger.info(f"   Límite: {products_per_hour} productos/hora")
        
        start_time = time.time()
        products_created = 0
        
        try:
            if source == "csv":
                products = self._load_products_from_csv(source_path)
            elif source == "excel":
                products = self._load_products_from_excel(source_path)
            else:
                raise ValueError(f"Fuente no soportada: {source}")
            
            total_products = len(products)
            logger.logger.info(f"   Productos a procesar: {total_products}")
            
            # Calcular intervalo entre productos para alcanzar el límite
            interval = 3600.0 / products_per_hour if products_per_hour > 0 else 0
            
            for i, product in enumerate(products):
                sku = product.get("Sku") or product.get("sku") or f"UNKNOWN_{i}"
                
                logger.logger.info(f"[{i+1}/{total_products}] Procesando {sku}...")
                
                result = self.create_product(product)
                
                if result.success:
                    products_created += 1
                    logger.logger.info(f"   ✅ Creado: {result.product_id}")
                else:
                    logger.logger.error(f"   ❌ Error: {result.error}")
                
                # Calcular tiempo restante
                elapsed = time.time() - start_time
                estimated_total = (elapsed / (i + 1)) * total_products if i > 0 else 0
                remaining = estimated_total - elapsed
                
                logger.logger.info(
                    f"   Tiempo: {elapsed:.1f}s | "
                    f"Estimado: {estimated_total:.1f}s | "
                    f"Restante: {remaining:.1f}s"
                )
                
                # Esperar para mantener el rate
                if interval > 0 and i < total_products - 1:
                    sleep_time = max(0, interval - (time.time() - start_time - (i * interval)))
                    if sleep_time > 0:
                        logger.logger.debug(f"   ⏳ Esperando {sleep_time:.2f}s para rate limiting...")
                        time.sleep(sleep_time)
                
                start_time = time.time()  # Reiniciar timer para el siguiente
            
            logger.logger.info(f"✅ Creación continua finalizada: {products_created}/{total_products} creados")
            
        except Exception as e:
            logger.logger.error(f"❌ Error en creación continua: {e}")
            raise
    
    def _load_products_from_csv(self, csv_path: str) -> List[Dict[str, Any]]:
        """Cargar productos desde CSV"""
        products = []
        try:
            with open(csv_path, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    products.append(dict(row))
            logger.logger.info(f"✅ Cargados {len(products)} productos desde {csv_path}")
        except Exception as e:
            logger.logger.error(f"❌ Error leyendo CSV {csv_path}: {e}")
        return products
    
    def _load_products_from_excel(self, excel_path: str) -> List[Dict[str, Any]]:
        """Cargar productos desde Excel"""
        products = []
        try:
            df = pd.read_excel(excel_path)
            products = df.to_dict('records')
            logger.logger.info(f"✅ Cargados {len(products)} productos desde {excel_path}")
        except Exception as e:
            logger.logger.error(f"❌ Error leyendo Excel {excel_path}: {e}")
        return products
    
    def _adapt_to_cdiscount_format(self, product_data: Dict[str, Any]) -> Dict[str, Any]:
        """Adaptar datos de producto al formato de Cdiscount API"""
        
        # Formato básico para Cdiscount
        cdiscount_product = {
            "Sku": product_data.get("Sku") or product_data.get("sku"),
            "Ean": product_data.get("Ean") or product_data.get("ean") or product_data.get("GTIN"),
            "Name": product_data.get("Name") or product_data.get("name"),
            "Brand": product_data.get("Brand") or product_data.get("brand") or "Generic",
            "Description": product_data.get("Description") or product_data.get("description") or "",
            "Price": float(product_data.get("Price") or product_data.get("price") or 0),
            "Stock": int(product_data.get("Stock") or product_data.get("stock") or product_config.DEFAULT_STOCK),
        }
        
        # Mapear categoría
        category = product_data.get("Category") or product_data.get("category")
        if category:
            category_id = product_config.CATEGORY_MAPPING.get(category)
            if category_id:
                cdiscount_product["CategoryId"] = category_id
        
        # Imágenes
        images = product_data.get("Images") or product_data.get("images")
        if images:
            if isinstance(images, str):
                cdiscount_product["Images"] = [images]
            elif isinstance(images, list):
                cdiscount_product["Images"] = images
        
        # Atributos adicionales
        additional_attrs = {}
        for key, value in product_data.items():
            if key not in cdiscount_product and value:
                additional_attrs[key] = value
        
        if additional_attrs:
            cdiscount_product["AdditionalAttributes"] = additional_attrs
        
        return cdiscount_product
    
    def get_stats(self) -> Dict[str, Any]:
        """Obtener estadísticas de la sesión"""
        elapsed = time.time() - self.session_start
        
        return {
            "total_created": self.total_created,
            "total_failed": self.total_failed,
            "total_skipped": self.total_skipped,
            "creation_rate": self.total_created / elapsed * 3600 if elapsed > 0 else 0,
            "uptime": elapsed,
            "errors": self.session_errors
        }


# Instancia global
creator = CdiscountProductCreator()


def create_products(products: List[Dict[str, Any]], 
                   batch_size: int = config.BATCH_SIZE) -> BatchResult:
    """Función conveniente para crear productos"""
    return creator.create_products_batch(products, batch_size)


def create_from_csv(csv_path: str, batch_size: int = config.BATCH_SIZE) -> BatchResult:
    """Función conveniente para crear desde CSV"""
    return creator.create_from_csv(csv_path, batch_size)


def create_from_excel(excel_path: str, batch_size: int = config.BATCH_SIZE) -> BatchResult:
    """Función conveniente para crear desde Excel"""
    return creator.create_from_excel(excel_path, batch_size)
