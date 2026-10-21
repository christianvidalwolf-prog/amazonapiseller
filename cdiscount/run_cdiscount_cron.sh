#!/bin/bash
# ==============================================================================
# Script Cron para Creación de Productos en Cdiscount
# ==============================================================================
# 
# Este script se ejecuta cada hora y crea exactamente 50 productos en Cdiscount
# 
# Configuración en crontab:
# 0 * * * * /bin/bash /Users/christianvidalwolf/orca/amazonapiseller/cdiscount/run_cdiscount_cron.sh
#
# Para ejecutar cada 30 minutos (2 lotes de 25 productos):
# 0,30 * * * * /bin/bash /Users/christianvidalwolf/orca/amazonapiseller/cdiscount/run_cdiscount_cron.sh
#

set -e
set -o pipefail

# ============================================================================
# CONFIGURACIÓN
# ============================================================================

SCRIPT_DIR="/Users/christianvidalwolf/orca/amazonapiseller/cdiscount"
PROJECT_DIR="/Users/christianvidalwolf/orca/amazonapiseller"
PYTHON="/usr/bin/python3"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/cdiscount_cron_$(date +%Y%m%d).log"
ERROR_LOG="$LOG_DIR/cdiscount_cron_errors.log"

# Ruta al archivo fuente (CSV o Excel con productos pendientes)
SOURCE_PATH="/Users/christianvidalwolf/Stock/productos_pendientes_cdiscount.csv"

# Tamaño del lote (50 productos/hora)
BATCH_SIZE=50

# ============================================================================
# INICIALIZACIÓN
# ============================================================================

# Crear directorios
mkdir -p "$LOG_DIR"

# Redirigir salida a logs
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================================================="
echo "INICIO DE EJECUCIÓN CRON - $(date)"
echo "=========================================================================="

# Verificar que Python está disponible
if ! command -v "$PYTHON" &> /dev/null; then
    echo "❌ ERROR: Python no encontrado en $PYTHON"
    exit 1
fi

# Cambiar a directorio del proyecto
cd "$PROJECT_DIR" || {
    echo "❌ ERROR: No se puede acceder a $PROJECT_DIR"
    exit 1
}

# Verificar que el archivo fuente existe
if [ ! -f "$SOURCE_PATH" ]; then
    echo "⚠️ ADVERTENCIA: Archivo fuente no encontrado: $SOURCE_PATH"
    echo "   Creando archivo vacío para evitar errores..."
    touch "$SOURCE_PATH"
fi

# ============================================================================
# EJECUCIÓN PRINCIPAL
# ============================================================================

echo "🔄 Verificando dependencias..."

# Verificar que las dependencias de Python están instaladas
if ! "$PYTHON" -c "import requests, pandas; print('✅ Dependencias OK')" 2>/dev/null; then
    echo "⚠️ Instalando dependencias..."
    pip install requests pandas 2>&1 | grep -E "(Successfully|already|Requirement)" || true
fi

# Exportar variables de entorno
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "📄 Cargando variables de entorno desde .env"
    # Exportar variables definidas en .env
    while IFS='=' read -r key value; do
        # Ignorar comentarios y líneas vacías
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        # Eliminar comillas y espacios
        key=$(echo "$key" | tr -d '"' | xargs)
        value=$(echo "$value" | tr -d '"' | xargs)
        export "$key=$value"
    done < "$PROJECT_DIR/.env"
fi

echo "🚀 Iniciando creación de productos en Cdiscount..."
echo "   Fuente: $SOURCE_PATH"
echo "   Lote: $BATCH_SIZE productos"
echo ""

# Ejecutar el gestor de cron de Python
PYTHON_RESULT=0
"$PYTHON" "$SCRIPT_DIR/cron_manager.py" \
    --source csv \
    --source-path "$SOURCE_PATH" \
    --batch-size $BATCH_SIZE \
    2>&1 || PYTHON_RESULT=$?

# ============================================================================
# MANEJO DE RESULTADO
# ============================================================================

if [ $PYTHON_RESULT -eq 0 ]; then
    echo ""
    echo "✅ EJECUCIÓN COMPLETADA CON ÉXITO"
    
    # Mostrar estadísticas recientes
    echo ""
    echo "📊 Estadísticas:"
    "$PYTHON" "$SCRIPT_DIR/cron_manager.py" --stats 2>/dev/null | grep -E "(created|failed|hourly)" || true
else
    echo ""
    echo "❌ EJECUCIÓN CON ERRORES (código: $PYTHON_RESULT)"
    
    # Guardar error en archivo separado
    echo "Error en ejecución: $(date)" >> "$ERROR_LOG"
    echo "Código de salida: $PYTHON_RESULT" >> "$ERROR_LOG"
fi

echo "=========================================================================="
echo "FIN DE EJECUCIÓN - $(date)"
echo "=========================================================================="

exit $PYTHON_RESULT
