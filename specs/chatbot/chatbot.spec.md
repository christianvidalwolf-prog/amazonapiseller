# Especificación SDD: Chatbot público de www.vidalregals.com
**Módulo:** `chatbot`
**Versión:** 1.0.0
**Estado:** Activo

---

## 1. Propósito y alcance
Asistente de chat en la web pública de PrestaShop (www.vidalregals.com) que:
- busca y recomienda productos activos del catálogo (fichas con foto, precio con IVA y enlace);
- responde dudas de envíos, devoluciones, pagos y contacto con la información de las páginas CMS de la tienda.

Fuera de alcance en v1: estado de pedidos, datos de clientes, cambios en la tienda. El bot nunca escribe en PrestaShop ni en Amazon.

## 2. Arquitectura
| Pieza | Fichero | Qué hace |
|---|---|---|
| Catálogo | `prestashop/build_chat_catalog.py` | Lee del Webservice (solo GET) productos activos, stock (`stock_availables`, combinación 0), categorías e IVA de España; publica `snapshots['chatbot:catalog']` en Supabase. |
| Programación | `.github/workflows/chatbot-catalog.yml` | Cada noche (04:30 UTC), manual o al cambiar el script. Secretos: `PS_URL`, `PS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. |
| API | `frontend/app/api/public/chat/route.ts` | `POST /api/public/chat` (+ `OPTIONS`). Pública, fuera del middleware de `APP_PASSWORD`. |
| Lógica | `frontend/lib/chatbot/{agent,catalog,storeInfo,rateLimit}.ts` | Bucle de herramientas con Claude, búsqueda, textos de la tienda, límite por IP. |
| Widget | `frontend/public/chat-widget.js` | JS sin dependencias, Shadow DOM, idioma según `<html lang>` (es/en/fr/de/it), historial en `sessionStorage`. |

Instalación en PrestaShop: `<script src="https://amazonapiseller.vercel.app/chat-widget.js" defer></script>` en el pie del tema (o un bloque HTML personalizado). Atributos opcionales `data-color` y `data-api`.

## 3. Contrato de la API
**Petición** `POST /api/public/chat`
```json
{ "messages": [ { "role": "user" | "assistant", "text": "..." } ] }
```
- Máximo 20 turnos (se usan los últimos), 1.000 caracteres por mensaje; turnos consecutivos del mismo rol se unen; el último debe ser `user`.
- Los turnos `assistant` llevan los productos como marcadores `{{producto:ID}}`.

**Respuesta** `200` (también `429`/`503` con texto para el cliente)
```json
{ "segments": [ { "type": "text", "text": "..." },
                { "type": "product", "product": { "id": 1, "name": "...", "price": 19.9, "inStock": true, "url": "...", "image": "..." } } ] }
```
Errores: `400 invalid messages`, `403 origin not allowed`.

## 4. Reglas de negocio
1. **Sin invenciones:** el modelo solo puede mostrar productos mediante `{{producto:ID}}`; el servidor descarta ids que no existan en el catálogo y construye la ficha (precio, URL, imagen) desde el catálogo, nunca desde el texto del modelo. Máx. 4 fichas por respuesta.
2. **Stock:** por defecto solo se buscan productos con stock > 0.
3. **Precio:** `price` (sin IVA) × (1 + IVA de España del `id_tax_rules_group`); 21 % si no se puede leer. No incluye precios específicos/descuentos: el bot avisa de que la ficha puede tener descuento.
4. **Información de la tienda:** `frontend/lib/chatbot/storeInfo.ts` copia las páginas CMS 1, 4, 5 y 6. Si cambian en la web, se actualiza ese fichero.
5. **Derivación a persona:** pedidos, facturas, incidencias, envíos a Canarias/Baleares → email vidalregals@gmail.com / tel. 93 180 16 17 (L–V 10–15 h).

## 5. Seguridad, privacidad y coste
- Rutas públicas exactas en `frontend/middleware.ts`: `/chat-widget.js` y `/api/public/chat`; el resto del panel sigue tras `APP_PASSWORD`.
- CORS: solo `CHATBOT_ALLOWED_ORIGINS` (por defecto `https://www.vidalregals.com,https://vidalregals.com`; localhost y peticiones sin `Origin` solo fuera de producción).
- Tiempo: cliente de Anthropic con timeout 20 s y 1 reintento, plazo total 25 s (< `maxDuration` 30 s) y `max_tokens` 1024; en la última ronda `tool_choice: none` obliga a responder.
- Riesgo aceptado: el historial lo envía el navegador, así que un atacante puede falsear turnos `assistant` previos; solo lo ve él y las fichas siguen saliendo del catálogo. Si se convierte en problema: firmar con HMAC las respuestas del bot.
- El catálogo excluye productos con `visibility=none` o `available_for_order=0`.
- Límite por IP en memoria (`CHATBOT_MAX_MESSAGES_PER_10MIN`, 30); techo de coste real = límite de gasto de la clave de Anthropic.
- No se guardan conversaciones ni datos personales en servidor; el historial vive en `sessionStorage` del visitante. El widget pinta todo con `textContent` y solo admite URLs http(s).
- La key del Webservice solo necesita permiso GET en `products`, `categories`, `stock_availables`, `taxes`, `tax_rules`.
- Modelo: `CHATBOT_MODEL` (por defecto `claude-haiku-5-5`, effort `low`, máx. 4 rondas de herramienta por mensaje).

## 6. Variables de entorno (Vercel)
`ANTHROPIC_API_KEY` (obligatoria), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (ya existentes), opcionales `CHATBOT_MODEL`, `CHATBOT_ALLOWED_ORIGINS`, `CHATBOT_MAX_MESSAGES_PER_10MIN`.
