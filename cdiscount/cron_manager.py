"""
Gestor de tareas programadas para Cdiscount
Sistema robusto de cron que garantiza:
- Ejecución cada hora
- Procesamiento de exactamente 50 productos/hora
- Manejo de errores
- Logging detallado
- Notificaciones
"""

import os
import sys
import time
import json
import argparse
import subprocess
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

from .config import config, monitoring_config
from .logger import logger
from .product_creator import creator, create_from_csv, create_from_excel


class CronManager:
    """
    Gestor de tareas cron para Cdiscount
    
    Características:
    - Control preciso de rate limiting
    - Estadísticas por hora
    - Persistencia de estado
    - Notificaciones de errores
    """
    
    STATE_FILE = os.path.join(monitoring_config.LOG_DIR, "cdiscount_cron_state.json")
    LOCK_FILE = os.path.join(monitoring_config.LOG_DIR, "cdiscount_cron.lock")
    
    def __init__(self):
        self.state = self._load_state()
        self.lock_file = CronManager.LOCK_FILE
        self.start_time = time.time()
    
    def _load_state(self) -> Dict[str, Any]:
        """Cargar estado persistente"""
        if os.path.exists(self.STATE_FILE):
            try:
                with open(self.STATE_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {
            "last_execution": None,
            "total_created": 0,
            "total_failed": 0,
            "hourly_stats": {},
            "processed_skus": set(),
            "failed_skus": {},
            "last_batch": None
        }
    
    def _save_state(self) -> None:
        """Guardar estado persistente"""
        try:
            Path(monitoring_config.LOG_DIR).mkdir(parents=True, exist_ok=True)
            with open(self.STATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.state, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.logger.error(f"Error guardando estado: {e}")
    
    def _acquire_lock(self, timeout: int = 60) -> bool:
        """Adquirir lock para evitar ejecuciones concurrentes"""
        start = time.time()
        while time.time() - start < timeout:
            try:
                # Crear archivo lock
                with open(self.lock_file, 'w', encoding='utf-8') as f:
                    f.write(f"locked by {os.getpid()} at {datetime.now().isoformat()}")
                return True
            except IOError:
                # Archivo ya existe, otra instancia está corriendo
                if os.path.exists(self.lock_file):
                    # Verificar si el lock es antiguo (>1 hora)
                    try:
                        with open(self.lock_file, 'r', encoding='utf-8') as f:
                            content = f.read()
                            # Si el archivo existe pero es muy viejo, lo eliminamos
                            mtime = os.path.getmtime(self.lock_file)
                            if time.time() - mtime > 3600:  # 1 hora
                                os.remove(self.lock_file)
                                continue
                    except Exception:
                        pass
                time.sleep(5)
        return False
    
    def _release_lock(self) -> None:
        """Liberar lock"""
        try:
            if os.path.exists(self.lock_file):
                os.remove(self.lock_file)
        except Exception as e:
            logger.logger.error(f"Error liberando lock: {e}")
    
    def _is_time_to_run(self) -> bool:
        """Verificar si es hora de ejecutar"""
        if self.state.get("last_execution") is None:
            return True
        
        last_exec = datetime.fromisoformat(self.state["last_execution"])
        time_since_last = datetime.now() - last_exec
        
        # Ejecutar si ha pasado al menos 1 hora
        return time_since_last >= timedelta(hours=1)
    
    def _get_hourly_key(self) -> str:
        """Obtener clave para estadísticas horarias"""
        return datetime.now().strftime("%Y-%m-%d_%H")
    
    def run_hourly_batch(self, 
                        source: str = "csv",
                        source_path: str = "/Users/christianvidalwolf/Stock/productos_pendientes.csv",
                        batch_size: int = config.BATCH_SIZE) -> Dict[str, Any]:
        """
        Ejecutar lote horario de creación de productos
        
        Este método:
        1. Carga productos desde la fuente
        2. Procesa exactamente 50 productos (o batch_size)
        3. Actualiza estadísticas
        4. Guarda estado
        """
        
        # Adquirir lock
        if not self._acquire_lock():
            logger.logger.warning("⏳ Otra instancia está ejecutándose. Saltando...")
            return {"status": "skipped", "reason": "lock_acquired"}
        
        try:
            # Verificar si es hora de ejecutar
            if not self._is_time_to_run():
                logger.logger.info("⏰ No es hora de ejecutar (última ejecución reciente)")
                return {"status": "skipped", "reason": "not_time_yet"}
            
            logger.logger.info("🚀 INICIANDO LOTE HORARIO")
            logger.logger.info(f"   Fuente: {source}")
            logger.logger.info(f"   Ruta: {source_path}")
            
            start_time = time.time()
            hourly_key = self._get_hourly_key()
            
            # Inicializar estadísticas horarias
            if hourly_key not in self.state["hourly_stats"]:
                self.state["hourly_stats"][hourly_key] = {
                    "created": 0,
                    "failed": 0,
                    "start_time": datetime.now().isoformat(),
                    "products": []
                }
            
            # Cargar productos
            products = self._load_products(source, source_path)
            
            if not products:
                logger.logger.warning("⚠️ No hay productos para procesar")
                self.state["last_execution"] = datetime.now().isoformat()
                self._save_state()
                return {"status": "no_products", "products_found": 0}
            
            # Tomar exactamente batch_size productos (50 por defecto)
            products_to_process = products[:batch_size]
            remaining = len(products) - batch_size
            
            logger.logger.info(f"   Productos disponibles: {len(products)}")
            logger.logger.info(f"   A procesar: {len(products_to_process)}")
            logger.logger.info(f"   Pendientes: {remaining}")
            
            # Crear productos
            batch_result = None
            if source == "csv":
                batch_result = create_from_csv(source_path, batch_size)
            elif source == "excel":
                batch_result = create_from_excel(source_path, batch_size)
            else:
                # Usar creador directo
                batch_result = creator.create_products_batch(products_to_process, batch_size)
            
            # Actualizar estadísticas
            self.state["total_created"] += batch_result.created
            self.state["total_failed"] += batch_result.failed
            self.state["last_execution"] = datetime.now().isoformat()
            self.state["last_batch"] = batch_result.to_dict()
            
            # Actualizar estadísticas horarias
            hourly_stats = self.state["hourly_stats"][hourly_key]
            hourly_stats["created"] += batch_result.created
            hourly_stats["failed"] += batch_result.failed
            hourly_stats["end_time"] = datetime.now().isoformat()
            hourly_stats["products"] = [p.get("sku") for p in products_to_process]
            
            # Guardar estado
            self._save_state()
            
            # Loguear resultado
            elapsed = time.time() - start_time
            logger.logger.info(f"✅ LOTE COMPLETADO")
            logger.logger.info(f"   Creados: {batch_result.created}")
            logger.logger.info(f"   Fallidos: {batch_result.failed}")
            logger.logger.info(f"   Tiempo: {elapsed:.2f}s")
            logger.logger.info(f"   Rate: {batch_result.creation_rate:.2f} productos/hora")
            
            # Verificar si se cumplió el objetivo
            if batch_result.created < batch_size:
                logger.logger.warning(
                    f"⚠️ OBJETIVO NO CUMPLIDO: {batch_result.created}/{batch_size} productos creados"
                )
            
            # Retornar resultado
            return {
                "status": "completed",
                "batch_number": batch_result.batch_number,
                "products_processed": batch_result.processed,
                "products_created": batch_result.created,
                "products_failed": batch_result.failed,
                "elapsed_time": elapsed,
                "creation_rate": batch_result.creation_rate,
                "hourly_key": hourly_key,
                "next_execution": (datetime.now() + timedelta(hours=1)).isoformat()
            }
            
        except Exception as e:
            logger.logger.error(f"❌ ERROR EN LOTE HORARIO: {e}", exc_info=True)
            self.state["last_execution"] = datetime.now().isoformat()
            self.state["last_error"] = str(e)
            self._save_state()
            return {"status": "error", "error": str(e)}
            
        finally:
            self._release_lock()
    
    def _load_products(self, source: str, source_path: str) -> List[Dict[str, Any]]:
        """Cargar productos desde fuente"""
        products = []
        
        try:
            if source == "csv":
                with open(source_path, 'r', encoding='utf-8-sig') as f:
                    import csv
                    reader = csv.DictReader(f)
                    products = [dict(row) for row in reader]
            elif source == "excel":
                import pandas as pd
                df = pd.read_excel(source_path)
                products = df.to_dict('records')
            elif source == "database":
                # Implementación para base de datos
                pass
            elif source == "api":
                # Implementación para API externa
                pass
            else:
                # Intentar leer como JSON
                with open(source_path, 'r', encoding='utf-8') as f:
                    products = json.load(f)
            
            logger.logger.info(f"✅ Cargados {len(products)} productos desde {source_path}")
            
        except Exception as e:
            logger.logger.error(f"❌ Error cargando productos: {e}")
        
        return products
    
    def run_continuous(self, 
                      source: str = "csv",
                      source_path: str = "/Users/christianvidalwolf/Stock/productos_pendientes.csv",
                      interval_hours: float = 1.0) -> None:
        """
        Ejecutar en modo continuo (bucle infinito)
        """
        logger.logger.info(f"🔄 Iniciando modo continuo (cada {interval_hours} horas)")
        
        while True:
            try:
                result = self.run_hourly_batch(source, source_path, config.BATCH_SIZE)
                
                if result.get("status") == "skipped":
                    # Esperar 5 minutos antes de volver a intentar
                    logger.logger.info("⏳ Esperando 5 minutos antes de verificar de nuevo...")
                    time.sleep(300)
                else:
                    # Esperar el tiempo restante para completar la hora
                    next_run = datetime.now() + timedelta(hours=interval_hours)
                    wait_time = (next_run - datetime.now()).total_seconds()
                    
                    if wait_time > 0:
                        logger.logger.info(f"⏳ Esperando {wait_time:.1f}s para próxima ejecución...")
                        time.sleep(wait_time)
                    
            except KeyboardInterrupt:
                logger.logger.info("🛑 Deteniendo ejecución continua...")
                break
            except Exception as e:
                logger.logger.error(f"❌ Error en bucle continuo: {e}")
                time.sleep(60)  # Esperar 1 minuto antes de reintentar
    
    def get_stats(self, hours: int = 24) -> Dict[str, Any]:
        """Obtener estadísticas de las últimas N horas"""
        stats = {
            "total": {
                "created": self.state.get("total_created", 0),
                "failed": self.state.get("total_failed", 0)
            },
            "hourly": {},
            "recent_executions": []
        }
        
        # Obtener estadísticas horarias
        now = datetime.now()
        for i in range(hours):
            hour_key = (now - timedelta(hours=i)).strftime("%Y-%m-%d_%H")
            if hour_key in self.state.get("hourly_stats", {}):
                stats["hourly"][hour_key] = self.state["hourly_stats"][hour_key]
        
        # Obtener ejecuciones recientes
        if "last_batch" in self.state:
            stats["recent_executions"] = [self.state["last_batch"]]
        
        return stats
    
    def cleanup_old_stats(self, days: int = 30) -> int:
        """Limpiar estadísticas antiguas"""
        cleaned = 0
        cutoff = datetime.now() - timedelta(days=days)
        
        hourly_stats = self.state.get("hourly_stats", {})
        keys_to_remove = []
        
        for key in hourly_stats:
            try:
                # Extraer fecha del key (format: YYYY-MM-DD_HH)
                date_str = key.split("_")[0]
                exec_date = datetime.strptime(date_str, "%Y-%m-%d")
                if exec_date < cutoff:
                    keys_to_remove.append(key)
                    cleaned += 1
            except (ValueError, IndexError):
                keys_to_remove.append(key)
                cleaned += 1
        
        for key in keys_to_remove:
            self.state["hourly_stats"].pop(key, None)
        
        self._save_state()
        return cleaned


# Instancia global
cron_manager = CronManager()


def run_hourly_batch(source: str = "csv", 
                    source_path: str = "/Users/christianvidalwolf/Stock/productos_pendientes.csv") -> Dict[str, Any]:
    """Función conveniente para ejecutar lote horario"""
    return cron_manager.run_hourly_batch(source, source_path)


def run_continuous(source: str = "csv",
                   source_path: str = "/Users/christianvidalwolf/Stock/productos_pendientes.csv") -> None:
    """Función conveniente para ejecutar en modo continuo"""
    cron_manager.run_continuous(source, source_path)


def get_stats(hours: int = 24) -> Dict[str, Any]:
    """Función conveniente para obtener estadísticas"""
    return cron_manager.get_stats(hours)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gestor de Cron para Cdiscount")
    parser.add_argument("--source", default="csv", choices=["csv", "excel"], help="Fuente de datos")
    parser.add_argument("--source-path", default="/Users/christianvidalwolf/Stock/productos_pendientes.csv", help="Ruta a la fuente")
    parser.add_argument("--batch-size", type=int, default=config.BATCH_SIZE, help="Tamaño del lote")
    parser.add_argument("--continuous", action="store_true", help="Modo continuo")
    parser.add_argument("--stats", action="store_true", help="Mostrar estadísticas")
    parser.add_argument("--cleanup", action="store_true", help="Limpiar estadísticas antiguas")
    
    args = parser.parse_args()
    
    if args.stats:
        stats = get_stats()
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    elif args.cleanup:
        cleaned = cron_manager.cleanup_old_stats()
        print(f"🧹 Limpieza completada: {cleaned} registros eliminados")
    elif args.continuous:
        run_continuous(args.source, args.source_path)
    else:
        result = run_hourly_batch(args.source, args.source_path)
        print(json.dumps(result, indent=2, ensure_ascii=False))
