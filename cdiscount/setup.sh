#!/bin/bash
# ==============================================================================
# Script de Instalación Rápida para el Sistema Cdiscount
# ==============================================================================

set -e

echo "=========================================================================="
echo "🚀 INSTALACIÓN DEL SISTEMA DE CREACIÓN DE PRODUCTOS EN CDISCOUNT"
echo "=========================================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "📁 Directorio: $SCRIPT_DIR"
echo ""

# 1. Crear entorno virtual (opcional)
echo "1️⃣ Configurando entorno Python..."
if [ ! -d "$SCRIPT_DIR/venv" ]; then
    echo "   Creando entorno virtual..."
    python3 -m venv "$SCRIPT_DIR/venv"
fi

# Activar entorno virtual
if [ -f "$SCRIPT_DIR/venv/bin/activate" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
    echo "   ✅ Entorno virtual activado"
else
    echo "   ℹ️ Usando Python del sistema"
fi

# 2. Instalar dependencias
echo ""
echo "2️⃣ Instalando dependencias..."
pip install -r "$SCRIPT_DIR/requirements.txt" 2>&1 | grep -E "(Successfully|Requirement|already)" || true
echo "   ✅ Dependencias instaladas"

# 3. Crear archivo .env si no existe
echo ""
echo "3️⃣ Configurando entorno..."
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "   Copiando .env.example a .env..."
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo "   ⚠️  DEBES EDITAR $SCRIPT_DIR/.env con tus credenciales de Cdiscount"
else
    echo "   ✅ Archivo .env ya existe"
fi

# 4. Crear directorio de logs
echo ""
echo "4️⃣ Creando directorios..."
mkdir -p "$SCRIPT_DIR/logs"
echo "   ✅ Directorios creados"

# 5. Crear archivo de productos ejemplo si no existe
echo ""
echo "5️⃣ Preparando archivo de productos ejemplo..."
if [ ! -f "$SCRIPT_DIR/productos_pendientes_cdiscount.csv" ]; then
    cp "$SCRIPT_DIR/productos_ejemplo.csv" "$SCRIPT_DIR/productos_pendientes_cdiscount.csv"
    echo "   ✅ Archivo de ejemplo copiado"
    echo "   Puedes modificar $SCRIPT_DIR/productos_pendientes_cdiscount.csv"
else
    echo "   ✅ Archivo de productos ya existe"
fi

# 6. Probar la conexión
echo ""
echo "6️⃣ Probando el sistema..."
cd "$SCRIPT_DIR"
if python main.py test 2>&1 | grep -q "✅"; then
    echo "   ✅ Prueba de conexión exitosa"
else
    echo "   ⚠️  La prueba falló. Asegúrate de que .env tiene credenciales válidas."
fi

# 7. Validar productos de ejemplo
echo ""
echo "7️⃣ Validando productos de ejemplo..."
python main.py validate --path "$SCRIPT_DIR/productos_pendientes_cdiscount.csv" --limit 5 2>&1 | tail -3 || true

# 8. Mostrar instrucciones finales
echo ""
echo "=========================================================================="
echo "✅ INSTALACIÓN COMPLETADA"
echo "=========================================================================="
echo ""
echo "📋 SIGUIENTES PASOS:"
echo ""
echo "1. Configura tus credenciales de Cdiscount:"
echo "   nano $SCRIPT_DIR/.env"
echo ""
echo "   Debes completar:"
echo "   - CDISCOUNT_CLIENT_ID"
echo "   - CDISCOUNT_CLIENT_SECRET"
echo "   - CDISCOUNT_API_KEY"
echo ""
echo "2. Prepara tu archivo de productos:"
echo "   - Coloca tus productos en: $SCRIPT_DIR/productos_pendientes_cdiscount.csv"
echo "   - O usa el archivo de ejemplo como plantilla"
echo ""
echo "3. Valida tus productos:"
echo "   python main.py validate --path $SCRIPT_DIR/productos_pendientes_cdiscount.csv"
echo ""
echo "4. Prueba la conexión:"
echo "   python main.py test"
echo ""
echo "5. Ejecuta manualmente (prueba):"
echo "   python main.py create --source csv --path $SCRIPT_DIR/productos_pendientes_cdiscount.csv --batch-size 5"
echo ""
echo "6. Configura el cron para ejecución automática:"
echo "   crontab -e"
echo ""
echo "   Añade esta línea:"
echo "   0 * * * * /bin/bash $SCRIPT_DIR/run_cdiscount_cron.sh"
echo ""
echo "7. Monitorea el progreso:"
echo "   python main.py stats"
echo ""
echo "8. Ver logs en tiempo real:"
echo "   tail -f $SCRIPT_DIR/logs/cdiscount_creation.log"
echo ""
echo "=========================================================================="
echo "📚 DOCUMENTACIÓN COMPLETA:"
echo "   cat $SCRIPT_DIR/README.md"
echo "=========================================================================="
echo ""
