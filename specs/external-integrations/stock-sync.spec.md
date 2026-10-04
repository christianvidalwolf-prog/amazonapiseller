# Especificación SDD: Sincronización Local de Stock & ERP
**Módulo:** `external-integrations/stock-sync`  
**Scripts vinculados:** `auto_update_stock.py`, `auto_update_stock_fast.py`  
**Ficheros de datos:** `signes_sgi_amazon.csv`  
**Versión:** 1.0.0  

---

## 1. Propósito y Alcance
Gobierna la integración y sincronización de stock físico procedente del sistema ERP/proveedor (`signes_sgi_amazon.csv`) hacia el inventario FBM/FBA de Amazon Seller Central mediante feeds SP-API.

## 2. Reglas Contractuales de Negocio
1. **Regla de Stock Cero (Protección contra roturas):**
   - Si un SKU aparece en el catálogo pero no existe en el CSV local, o su cantidad es `<= 0`, su stock publicado en Amazon debe actualizarse a `0` para evitar cancelaciones involuntarias de pedidos.
2. **Buffer de Seguridad (Safety Stock):**
   - Posibilidad de aplicar un factor de reserva: `stock_amazon = max(0, stock_csv - safety_buffer)`.
3. **Idempotencia y Lotes:**
   - La ingesta procesa cambios en lotes atómicos (chunks) evitando duplicar feeds si las cantidades no han variado desde la última comprobación (*diff check*).

## 3. Manejo de Errores
- Si el archivo CSV está corrupto, vacío o con menos columnas de las esperadas, abortar la sincronización sin alterar el inventario existente y generar alerta inmediata.
