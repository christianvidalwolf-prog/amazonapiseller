# Especificación SDD: Finance (Finanzas y Márgenes Netos)
**Módulo:** `finance`  
**Versión:** 1.0.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Conciliación financiera de todos los desembolsos, comisiones y liquidaciones de Amazon mediante Finances API. Calcula el beneficio neto real (*True Net Profit*) deduciendo cada coste asociado.

## 2. Ecuación Financiera Canónica
$$\text{Net Profit} = \text{Ingresos Brutos} - \text{Comisiones de Venta (Referral Fees)} - \text{Tarifas Logísticas FBA} - \text{Costes Almacenamiento} - \text{Gasto Publicidad (Ads)} - \text{Reembolsos/Devoluciones} - \text{COGS (Coste de Bienes Vendidos)}$$

## 3. Clasificación de Eventos Financieros
- `ShipmentEvent`: Ingresos brutos por productos y retenciones por tarifas de entrega.
- `RefundEvent`: Retorno de fondos al comprador y ajuste proporcional de comisiones.
- `ServiceFeeEvent`: Cuotas mensuales de suscripción profesional de vendedor y almacenamiento prolongado.
- `AdjustmentEvent`: Reembolsos por inventario perdido o dañado en almacenes de Amazon.

## 4. Endpoints y Operaciones
- `GET /api/finance/pnl`: Estado de pérdidas y ganancias (*P&L*) desglosado por periodo.
- `GET /api/finance/settlements`: Historial de liquidaciones bancarias transferidas por Amazon.
- `GET /api/finance/fees-breakdown`: Detalle porcentual de comisiones sobre ventas totales.
