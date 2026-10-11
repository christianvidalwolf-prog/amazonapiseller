#!/usr/bin/env python3
"""
Script principal para creación de productos en Cdiscount

Uso:
    python -m cdiscount.main create --source csv --path /ruta/a/productos.csv --batch-size 50
    python -m cdiscount.main cron --continuous
    python -m cdiscount.main stats --hours 24
    python -m cdiscount.main validate --path /ruta/a/productos.csv
"""

import os
import sys
import argparse
import json
from typing import Any, Dict

# Añadir el directorio cdiscount al path para imports absolutos
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import validate_config, config, monitoring_config
from logger import logger
from product_creator import creator, create_from_csv, create_from_excel
from cron_manager import cron_manager, run_hourly_batch, run_continuous, get_stats
from validation import validate_product, fix_product, ProductValidator


def command_create(args) -> int:
    """Comando para crear productos"""
    logger.logger.info(f"🚀 Creando productos desde {args.source}")
    
    try:
        if args.source == "csv":
            result = create_from_csv(args.path, args.batch_size)
        elif args.source == "excel":
            result = create_from_excel(args.path, args.batch_size)
        else:
            print("❌ Fuente no soportada. Usa 'csv' o 'excel'")
            return 1
        
        print(f"\n✅ Proceso completado:")
        print(f"   Productos procesados: {result.processed}")
        print(f"   Productos creados: {result.created}")
        print(f"   Productos fallidos: {result.failed}")
        print(f"   Tiempo: {result.duration:.2f}s")
        print(f"   Rate: {result.creation_rate:.2f} productos/hora")
        
        if result.failed > 0:
            print(f"\n⚠️ Errores:")
            for error in result.errors[:5]:  # Mostrar primeros 5 errores
                print(f"   - {error.get('sku')}: {error.get('error')}")
            if len(result.errors) > 5:
                print(f"   ... y {len(result.errors) - 5} errores más")
        
        return 0 if result.created > 0 or result.processed == 0 else 1
        
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def command_cron(args) -> int:
    """Comando para ejecutar como cron"""
    try:
        if args.continuous:
            logger.logger.info("🔄 Iniciando modo continuo...")
            run_continuous(args.source, args.path)
            return 0
        else:
            result = run_hourly_batch(args.source, args.path)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if result.get("status") == "completed" else 1
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def command_stats(args) -> int:
    """Comando para mostrar estadísticas"""
    try:
        stats = get_stats(args.hours)
        
        print("\n" + "="*70)
        print("📊 ESTADÍSTICAS DE CREACIÓN DE PRODUCTOS EN CDISCOUNT")
        print("="*70)
        
        # Totales
        total = stats.get("total", {})
        print(f"\n📈 TOTALES:")
        print(f"   Productos creados: {total.get('created', 0)}")
        print(f"   Productos fallidos: {total.get('failed', 0)}")
        
        # Por hora
        hourly = stats.get("hourly", {})
        if hourly:
            print(f"\n🕐 POR HORA (últimas {len(hourly)} horas):")
            for hour_key in sorted(hourly.keys(), reverse=True):
                hour_data = hourly[hour_key]
                created = hour_data.get("created", 0)
                failed = hour_data.get("failed", 0)
                print(f"   {hour_key}: ✅{created} ❌{failed}")
        
        # Ejecuciones recientes
        recent = stats.get("recent_executions", [])
        if recent:
            print(f"\n⏱️ EJECUCIONES RECIENTES:")
            for exec_data in recent[:5]:  # Últimas 5
                print(f"   {exec_data.get('start_time', 'N/A')}: {exec_data.get('products_created', 0)} creados")
        
        print("\n" + "="*70)
        return 0
        
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def command_validate(args) -> int:
    """Comando para validar productos"""
    import csv
    
    try:
        # Leer productos
        products = []
        if args.path.endswith('.csv'):
            with open(args.path, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                products = [dict(row) for row in reader]
        elif args.path.endswith('.xlsx'):
            import pandas as pd
            df = pd.read_excel(args.path)
            products = df.to_dict('records')
        else:
            # Intentar JSON
            with open(args.path, 'r', encoding='utf-8') as f:
                products = json.load(f)
        
        print(f"\n📋 Validando {len(products)} productos desde {args.path}\n")
        
        validator = ProductValidator()
        valid_count = 0
        invalid_count = 0
        
        for i, product in enumerate(products[:args.limit or len(products)]):
            sku = product.get("Sku") or product.get("sku") or f"Product_{i+1}"
            
            result = validator.validate(product)
            
            if result.is_valid:
                valid_count += 1
                if args.verbose:
                    print(f"✅ {sku}: Válido")
            else:
                invalid_count += 1
                print(f"❌ {sku}:")
                if result.missing_required:
                    print(f"   Campos faltantes: {', '.join(result.missing_required)}")
                if result.errors:
                    print(f"   Errores: {', '.join(result.errors)}")
                if result.warnings:
                    print(f"   ⚠️ Advertencias: {', '.join(result.warnings)}")
        
        print(f"\n{'='*50}")
        print(f"✅ Válidos: {valid_count}")
        print(f"❌ Inválidos: {invalid_count}")
        print(f"{'='*50}\n")
        
        return 0 if invalid_count == 0 else 1
        
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def command_cleanup(args) -> int:
    """Comando para limpiar datos antiguos"""
    try:
        cleaned = cron_manager.cleanup_old_stats(args.days)
        print(f"🧹 Limpieza completada: {cleaned} registros eliminados")
        return 0
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def command_test(args) -> int:
    """Comando para probar la conexión"""
    try:
        from api_client import get_api_client
        
        logger.logger.info("🧪 Probando conexión con Cdiscount API...")
        
        client = get_api_client()
        
        # Probar autenticación
        if client.auth_token:
            print("✅ Autenticación exitosa")
        else:
            print("❌ Error de autenticación")
            return 1
        
        # Probar llamada simple
        response = client.get("/products?page=1&pageSize=1")
        if response.success:
            print("✅ Conexión API exitosa")
            print(f"   Status: {response.status_code}")
        else:
            print(f"❌ Error en conexión API: {response.error}")
            return 1
        
        return 0
        
    except Exception as e:
        logger.logger.error(f"❌ Error: {e}")
        print(f"❌ Error: {e}")
        return 1


def main():
    """Función principal"""
    parser = argparse.ArgumentParser(
        description="Sistema de creación de productos en Cdiscount",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos:
  # Crear productos desde CSV
  python main.py create --source csv --path /ruta/productos.csv --batch-size 50
  
  # Ejecutar como cron (1 vez)
  python main.py cron --source csv --path /ruta/productos.csv
  
  # Ejecutar en modo continuo
  python main.py cron --source csv --path /ruta/productos.csv --continuous
  
  # Mostrar estadísticas
  python main.py stats --hours 24
  
  # Validar productos
  python main.py validate --path /ruta/productos.csv
  
  # Probar conexión
  python main.py test
  
  # Limpiar datos antiguos
  python main.py cleanup --days 30
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Comandos disponibles')
    
    # Comando create
    create_parser = subparsers.add_parser('create', help='Crear productos')
    create_parser.add_argument('--source', choices=['csv', 'excel'], default='csv', help='Fuente de datos')
    create_parser.add_argument('--path', required=True, help='Ruta al archivo')
    create_parser.add_argument('--batch-size', type=int, default=50, help='Tamaño del lote')
    
    # Comando cron
    cron_parser = subparsers.add_parser('cron', help='Ejecutar como cron')
    cron_parser.add_argument('--source', choices=['csv', 'excel'], default='csv', help='Fuente de datos')
    cron_parser.add_argument('--path', default='/Users/christianvidalwolf/Stock/productos_pendientes_cdiscount.csv', help='Ruta al archivo')
    cron_parser.add_argument('--batch-size', type=int, default=50, help='Tamaño del lote')
    cron_parser.add_argument('--continuous', action='store_true', help='Modo continuo')
    
    # Comando stats
    stats_parser = subparsers.add_parser('stats', help='Mostrar estadísticas')
    stats_parser.add_argument('--hours', type=int, default=24, help='Últimas N horas')
    
    # Comando validate
    validate_parser = subparsers.add_parser('validate', help='Validar productos')
    validate_parser.add_argument('--path', required=True, help='Ruta al archivo')
    validate_parser.add_argument('--limit', type=int, default=None, help='Límite de productos a validar')
    validate_parser.add_argument('--verbose', action='store_true', help='Mostrar detalles')
    
    # Comando cleanup
    cleanup_parser = subparsers.add_parser('cleanup', help='Limpiar datos antiguos')
    cleanup_parser.add_argument('--days', type=int, default=30, help='Días a mantener')
    
    # Comando test
    subparsers.add_parser('test', help='Probar conexión con API')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 0
    
    # Validar configuración
    if not validate_config():
        print("\n❌ Error: Configuración no válida")
        print("Por favor, configura las credenciales de Cdiscount en el archivo .env")
        return 1
    
    # Ejecutar comando
    command_handlers = {
        'create': command_create,
        'cron': command_cron,
        'stats': command_stats,
        'validate': command_validate,
        'cleanup': command_cleanup,
        'test': command_test
    }
    
    handler = command_handlers.get(args.command)
    if handler:
        return handler(args)
    else:
        print(f"❌ Comando no encontrado: {args.command}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
