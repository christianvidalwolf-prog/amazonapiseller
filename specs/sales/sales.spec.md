# Especificación SDD: Sales (Ventas y Pedidos)
**Módulo:** `sales`  
**Versión:** 1.1.0  
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
4. **Facturación bruta compatible con Sellerboard:** Para cada línea de pedido, la facturación bruta es `item-price + shipping-price + item-promotion-discount + ship-promotion-discount + gift-wrap-price`. Los campos `item-tax`, `shipping-tax` y `gift-wrap-tax` se muestran como desglose fiscal, pero no se suman a la facturación bruta. Los pedidos cancelados quedan excluidos y las devoluciones se restan de la facturación neta.

5. **Mismas cifras en web (PrestaShop) y Cdiscount que en Amazon:** `sync_external_sales.py` escribe sus pedidos en el formato del informe de pedidos de Amazon y sus reembolsos en el de `devoluciones_<año>.csv`, de modo que la facturación bruta, devoluciones, neta, IVA, unidades, pedidos, ticket medio y comparativa con el año anterior se calculan igual en todos los canales.
   - Precios con IVA en `item-price`/`shipping-price`; el IVA incluido va en `item-tax`/`shipping-tax` (Cdiscount: tipo de la línea, 20 % por defecto).
   - Fechas en UTC (PrestaShop guarda hora de la tienda, `PS_TIMEZONE`, por defecto Europe/Madrid).
   - Estados: cancelado/error de pago → `Cancelled`; pagado → `Shipped`; sin pagar → `Pending` y, pasados 15 días, `Cancelled` (no se cobró). Cdiscount: rechazado/cancelado → `Cancelled`, pendiente de aceptar/enviar → `Pending`.
   - Reembolso (PrestaShop estado 7; línea Cdiscount reembolsada/devuelta): la venta se mantiene en su fecha y se escribe una devolución (`reason = REFUNDED`) en la fecha del reembolso en `devoluciones_prestashop_<año>.csv` / `devoluciones_cdiscount_<año>.csv`, que el backend lee junto a las de Amazon.
   - Una devolución se valora siempre con el precio del producto de su línea de pedido (sin envío), buscando el pedido en todos los ficheros de ventas 2025/2026, igual en la tabla y en el desglose aunque el pedido sea de otro periodo.

## 3. Endpoints y Operaciones
- `GET /api/sales/overview`: Resumen MTD (Month to Date), YTD (Year to Date) y comparativas interanuales.
- `GET /api/sales/by-asin`: Desglose de ventas, unidades e ingresos por producto.
- `GET /api/sales/hourly-velocity`: Velocidad de pedidos por franjas horarias (útil para dayparting de PPC).

### 2.1 Desglose de Logística (FBA vs FBM) en Ventas
- **Métrica de Despacho (Unidades Vendidas):** La tarjeta "Logística de Envíos (Ventas FBA vs FBM)" reporta las unidades de pedidos confirmados y despachados por Amazon (AFN / FBA) vs las despachadas directamente por el vendedor (MFN / FBM) dentro del periodo de tiempo seleccionado.
- **Diferenciación con Inventario Físico:** Esta métrica NO refleja el stock físico disponible en tiempo real en los almacenes (el cual reside en el módulo de inventario y oscila actualmente en ~691 uds FBA disponibles).

### 2.2 Desglose Detallado de Ventas por Producto
- **Columna Canal:** La vista de desglose por producto (`PeriodSalesDetailResult.products`) incluye los canales de venta (`channels: string[]`) donde se vendió cada referencia (p. ej. `Amazon.es`, `Amazon.de`, `PrestaShop`, `Cdiscount`). En la interfaz se presenta una columna "Canal" previa a "Producto / Referencia" mostrando badges identificativos con el marketplace/canal correspondiente.
