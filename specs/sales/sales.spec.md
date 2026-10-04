# Especificación SDD: Sales (Ventas y Pedidos)
**Módulo:** `sales`  
**Versión:** 1.0.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Ingesta, normalización y análisis de pedidos (Orders API y Reports API). Seguimiento de facturación bruta, unidades vendidas, ticket medio y velocidad de venta por marketplace y ASIN.

## 2. Reglas de Negocio
1. **Estados de Pedido:**
   - `Pending`: No sumar a ingresos definitivos (aún no se ha verificado el pago del cliente).
   - `Shipped`: Confirmado y facturable.
   - `Canceled`: Excluir de métricas de facturación real.
2. **Atribución de Ventas:** Separación transparente entre ventas orgánicas y ventas atribuidas a publicidad (PPC).
3. **Consolidación Multidivisa:** Normalización a divisa base (`EUR`) utilizando tipos de cambio diarios si se opera en múltiples marketplaces europeos.

## 3. Endpoints y Operaciones
- `GET /api/sales/overview`: Resumen MTD (Month to Date), YTD (Year to Date) y comparativas interanuales.
- `GET /api/sales/by-asin`: Desglose de ventas, unidades e ingresos por producto.
- `GET /api/sales/hourly-velocity`: Velocidad de pedidos por franjas horarias (útil para dayparting de PPC).

### 2.1 Desglose de Logística (FBA vs FBM) en Ventas
- **Métrica de Despacho (Unidades Vendidas):** La tarjeta "Logística de Envíos (Ventas FBA vs FBM)" reporta las unidades de pedidos confirmados y despachados por Amazon (AFN / FBA) vs las despachadas directamente por el vendedor (MFN / FBM) dentro del periodo de tiempo seleccionado.
- **Diferenciación con Inventario Físico:** Esta métrica NO refleja el stock físico disponible en tiempo real en los almacenes (el cual reside en el módulo  y oscila actualmente en ~691 uds FBA disponibles).
