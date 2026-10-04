# Especificación SDD: Cliente SP-API Core & Rate Limits
**Módulo:** `spapi-core`  
**Versión:** 1.0.0  

---

## 1. Propósito y Alcance
Capa base de comunicación HTTP con la Selling Partner API de Amazon y Login with Amazon (LWA). Centraliza la autenticación, firma de peticiones, token refresh y gestión de cuotas de llamada (*Leaky Bucket*).

## 2. Parámetros de Rate Limiting por API
| Endpoint SP-API | Límite de Ráfaga (*Burst*) | Tasa de Refresco (*Rate*) | Estrategia ante 429 |
| :--- | :--- | :--- | :--- |
| **Reports API (createReport)** | 1 req | 1 req / min (0.0167 rps) | Espera activa de 90s y reintento |
| **Reports API (getReport / Doc)** | 10 req | 2.0 rps | Backoff exponencial (1s, 2s, 4s...) |
| **Orders API** | 20 req | 0.5 rps | Backoff exponencial con jitter |
| **Product Pricing API** | 10 req | 0.5 rps | Cola de prioridad |
| **Listings Items API** | 5 req | 5.0 rps | Lotes de ejecución secuencial |

## 3. Contrato de Autenticación LWA (Login with Amazon)
- El `access_token` tiene un TTL de 3600 segundos (1 hora).
- El cliente debe renovar de forma preventiva el token en el segundo 3300 (5 minutos antes del vencimiento) para evitar llamadas fallidas por token caducado en peticiones concurrentes.
