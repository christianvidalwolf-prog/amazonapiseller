# Especificación SDD: Advertising (Amazon Ads & PPC)
**Módulo:** `advertising`  
**Versión:** 1.0.0  
**Estado:** Activo  

---

## 1. Propósito y Alcance
Gestión algorítmica y supervisión de campañas publicitarias en Amazon Ads (Sponsored Products, Sponsored Brands y Sponsored Display) con enfoque *Profit-First*. Maximiza ventas orgánicas y de pago manteniendo el ACoS y TACoS dentro de los márgenes rentables.

## 2. Métricas y Fórmulas Contractuales
- **CTR (Click-Through Rate):** `Clicks / Impressions`
- **CPC (Cost Per Click):** `Spend / Clicks`
- **ACoS (Advertising Cost of Sales):** `(Spend / Sales) * 100`
- **ROAS (Return on Ad Spend):** `Sales / Spend`
- **Conversion Rate (CVR):** `Orders / Clicks`
- **TACoS (Total ACoS):** `(Total Ad Spend / Total Organic & Ad Sales) * 100`

## 3. Guardrails de Seguridad (Protección de Presupuesto)
1. **Límite de Incremento de Puja:** Ningún ajuste automático puede aumentar una puja más del **20%** en una sola iteración.
2. **Puja Máxima Absoluta (Max Bid Ceiling):** Por defecto **1.50 €** a menos que se defina un límite específico por SKU/Campaña.
3. **Cosecha de Keywords Negativas:** Términos de búsqueda con más de 15 clics y 0 ventas se clasifican automáticamente como `CANDIDATE_NEGATIVE_EXACT`.
4. **Registro de Auditoría:** Toda mutación de puja o estado de campaña debe persistirse con timestamp, valor anterior, nuevo valor y motivo algorítmico.

## 4. Endpoints y Operaciones
- `GET /api/advertising/campaigns`: Listado paginado de campañas con métricas agregadas por ventana de tiempo (`7d`, `14d`, `30d`, `custom`).
- `GET /api/advertising/keywords/harvest`: Sugerencias algorítmicas de palabras clave para negación o escalado.
- `PATCH /api/advertising/bids`: Actualización por lotes de pujas con validación previa de los guardrails.
- `POST /api/advertising/sync`: Sincronización de reportes de rendimiento con Amazon Ads API.
