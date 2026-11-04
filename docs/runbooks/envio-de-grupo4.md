# Runbook: plantilla de envío en Alemania (los baratos, con envío de pago)

Toda oferta **FBM** (`fulfillment-channel` = `DEFAULT`) del marketplace de Alemania
(`A1PA6795UKMFR9`, vendedor `A3RY0L9OY3TPHI`) con **precio efectivo < 35,00 €** tiene que llevar la
plantilla de **PAGO** (3,99 €), no la de envío gratis.

| Plantilla | `merchant_shipping_group` | Informe maestro | Cobra al cliente |
|---|---|---|---|
| **PAGO** (destino) | `legacy-template-id` | `GRUPO 0` (o atributo ausente) | **3,99 €** |
| **ENVÍO GRATIS** (origen) | `395e11ea-3c51-4820-aa8f-74e6cf2a4e72` | `GRUPO 4` | **0,00 €** |

> **Ojo con la premisa.** Una primera versión de esta regla tenía las dos plantillas invertidas (daba el
> UUID por plantilla de pago) y habría quitado el envío a ~9.800 listings baratos. La evidencia:
> `Product Pricing API getListingOffers` sobre nuestras propias ofertas → los SKU en el UUID devuelven
> `Shipping 0.00` y los que no lo llevan devuelven `3.99`; y los pedidos de los SKU `*DCI` / `*SGI` movidos
> el 25-26/10 (`sgi_reasignar_default.py`, 5.698 SKU) pasaron de 0,00 € a 3,99 € al cambiar del UUID a
> `legacy-template-id`. Detalle completo en `docs/planes/envio-de-grupo4-auditoria-2026-11-04.md`.

Herramientas: `backend/scripts/fix-de-shipping-group.ts` (orquestador) y
`backend/scripts/lib/de-shipping-group.ts` (regla pura, con tests en `de-shipping-group.test.ts`).
El verificador independiente es `backend/scripts/verify-de-shipping-group.ts`: no comparte parser ni
decisión con el corrector, relee cada listing en vivo y marca violación solo cuando el atributo es el UUID
gratis (el atributo ausente y `legacy-template-id` cobran 3,99 € y no son violación).

## 1. Qué se mueve y qué no

Se mueve **solo** la intersección de:

1. `fulfillment-channel` = `DEFAULT` (FBM). FBA (`AMAZON_EU`) no se toca nunca.

   > Matiz comprobado en el informe del 2026-11-04: un SKU **híbrido** (con oferta FBA y FBM a la vez)
   > aparece en el informe como `DEFAULT`. Los 6 `*FBA` que son híbridos (`5106VCFBA`, `2182985CLMFBA`,
   > `288450CLMFBA`, `29853SGFBA`, `305445CLMFBA`, `5074SGFBA`) salen como `DEFAULT` y sí entran. Por eso las
   > 104 filas que el informe da como `AMAZON_EU` dentro de `GRUPO 4` (78 de ellas < 35 €) son FBA sin oferta
   > FBM: su plantilla de envío no cobra nada y no hay fuga. Si alguna fuese híbrida, el verificador la vería
   > (él decide por canal en vivo) y el corrector no la tocaría: son las que pueden salir como violación
   > residual y hay que moverlas a mano.
2. está **hoy** en la plantilla de envío gratis (informe `GRUPO 4`, en vivo el UUID).
3. precio efectivo **< 35,00 €**.

No se toca nada más: ni los que ya están en `legacy-template-id` / atributo ausente (ya cobran 3,99 €), ni
los de ≥ 35 €, ni FBA, ni precios, ni stock, ni ningún otro atributo. Un SKU en una plantilla distinta de
las dos sale como `otra plantilla (no es la de envío gratis)` y no se toca.

**Lo que el corrector NO ve** (y es dinero que se queda en envío gratis): un listing cuyo **precio de
tarifa** del informe es ≥ 35 € pero que tiene una oferta vigente por debajo (caso conocido: `7932VC0`,
tarifa 43,90 €, oferta 32,92 €; y `2974VCO`, `3982VC`, `14914SGR`, `4203VC` con ofertas que no están en
`rules:sales`). La selección de candidatos se hace con el precio del informe; el precio en vivo solo se
relee **dentro** de los ya seleccionados. Están **fuera de los 4.865** a propósito: se detectan con el
verificador (`VERIFY_NEAR`, que comprueba siempre toda la banda hasta 47 €) y se corrigen aparte.

## 2. Precio efectivo

El informe maestro (`GET_MERCHANT_LISTINGS_ALL_DATA`) solo trae el **precio de tarifa**; no incluye la
oferta activa (`discounted_price`). El script calcula el precio efectivo así:

1. **Oferta registrada** (`rules:sales`, la pone `set_sale_price.py`) → es lo que paga el cliente. Manda
   sobre todo lo demás. Cuenta también la programada, igual que `readOfferPrices`.
2. **Precio manual del panel** (`rules:manual-price:<sku>:DE`, `backend/src/lib/manualPrices.ts`).
3. **`fixed_prices.csv`** (columna `pais` = DE).
4. **Precio del informe** (en la fase de aplicación, el de Amazon en vivo).

En la fase de aplicación el precio se vuelve a leer **en vivo** con `getListingsItem`
(`attributes.purchasable_offer`, audiencia `ALL`, marketplace DE; no la B2B) y se decide otra vez, con los
mismos overrides encima.

> **Ojo con el orden**: un precio fijo o manual manda sobre el que Amazon tenga en ese momento, en las dos
> direcciones. Si en el repo hay 39,90 € y en Amazon 29,90 €, el SKU no se mueve (se queda gratis hasta que
> el precio del repo baje). En la auditoría del 2026-11-04 no pasó en ninguno de los 4.865; si alguna vez
> pasa, esos SKU aparecen como violación en el verificador, que solo mira el precio de Amazon.

## 3. Comandos

```bash
cd backend

# Auditoría (por defecto). No escribe en Amazon.
npm run audit:de-shipping-group
DE_REPORT_TSV=../de_all_listing_report_fresh.tsv npm run audit:de-shipping-group

# Aplicación (escribe en Amazon). Empezar con un límite pequeño.
SHIPPING_GROUP_LIMIT=25 npm run fix:de-shipping-group
# después, por tandas: 500, 1000…
SHIPPING_GROUP_LIMIT=500 npm run fix:de-shipping-group
# el lote completo exige confirmación explícita (el tope por defecto es 5000):
SHIPPING_GROUP_CONFIRM=1 SHIPPING_GROUP_LIMIT=5000 npm run fix:de-shipping-group

# Verificación del envío REAL que ve el comprador (solo lectura; al día siguiente, ver §6)
SHIPPING_CHECK=5 npm run shipping:de-check
```

Las rutas por defecto (`blocked_skus.txt`, `fixed_prices.csv`, CSV de salida, estado) se resuelven desde la
ubicación del script, no del `cwd`. Si falta `blocked_skus.txt` o `fixed_prices.csv` el script **aborta**
en vez de seguir sin ellos: son los inputs que evitan mover lo que no toca.

| Variable | Para qué | Por defecto |
|---|---|---|
| `SHIPPING_GROUP_APPLY=1` | envía los PATCH a Amazon | no (solo audita) |
| `DE_REPORT_TSV` | usa ese TSV en vez de pedir el informe a Amazon | pide el informe |
| `SHIPPING_GROUP_LIMIT` | máximo de SKU a parchear por ejecución (debe ser entero ≥ 1) | `5000` |
| `SHIPPING_GROUP_CONFIRM=1` | obligatorio si el tope pasa de 500 | no |
| `SHIPPING_GROUP_STATE_TTL_DAYS` | días que un `ok` evita reintentar ese SKU (`0` = para siempre). Al caducar se relee en vivo: lento, pero solo repatchea lo que siga gratis | `30` |
| `SHIPPING_GROUP_AUDIT_CSV` | salida de la auditoría | `../de_shipping_group_audit.csv` |
| `SHIPPING_GROUP_ERRORS_CSV` | rechazos | `../de_shipping_group_errores.csv` |
| `SHIPPING_GROUP_APPLIED_CSV` | registro acumulado de los PATCH aceptados | `../de_shipping_group_aplicados.csv` |
| `FIXED_PRICES_CSV` / `BLOCKED_SKUS_FILE` | overrides y SKU retirados | raíz del repo |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | overrides (`rules:sales`, precios manuales) e informe | — |
| `SHIPPING_CHECK` / `--shipping=n` | modo comprobación del envío del comprador (`n` SKU) | desactivado (`--shipping` suelto → 10) |
| `SHIPPING_CHECK_SOURCE_CSV` | de dónde salen los SKU a comprobar | `../de_shipping_group_aplicados.csv` |
| `SHIPPING_CHECK_PAUSE_MS` / `SHIPPING_CHECK_MAX_TRIES` | pausa entre SKU y lecturas máximas | `1000` / `5n` |
| `SHIPPING_CHECK_CSV_OUT` | detalle de la comprobación | `../de_shipping_group_shipping_check.csv` |

Salidas:

- `de_shipping_group_audit.csv` (raíz, gitignored):
  `sku,asin,precio_informe,precio_efectivo,fuente_precio,grupo_actual,accion,motivo,familia,plantilla_origen,plantilla_destino`.
  `accion` es `ok` (nada que hacer), `mover` u `omitir` (con motivo: `sin precio`,
  `SKU retirado (blocked_skus.txt)`). `fuente_precio` dice qué mando (`informe`, `precio fijo`,
  `precio manual`, `oferta registrada`). `plantilla_origen` / `plantilla_destino` llevan el identificador de
  plantilla (UUID o `legacy-template-id`), no la etiqueta del informe. Es el plan de lo que se va a hacer:
  se **reescribe** en cada ejecución.
- `de_shipping_group_aplicados.csv`: registro **acumulado** (append) de lo que se cambió de verdad,
  `at,sku,plantilla_origen,plantilla_destino`, solo con PATCH `ACCEPTED`. Es la traza que sobrevive a la
  siguiente auditoría y la que hay que mirar para reconstruir qué tenía antes un SKU.
- `de_shipping_group_errores.csv`: `sku,codigo,mensaje` (se reescribe por ejecución; el estado guarda el
  último motivo de cada SKU).
- Supabase: `rules:de-shipping-group:last-run` (auditoría) y `rules:de-shipping-group:last-apply`
  (aplicación, con `plantillas.origen` / `plantillas.destino`, `resultados` y `aplicados.muestra`).
- `backend/data/de-shipping-group-state.json` (gitignored): `sku → {status: ok|err, motivo, at, origen, destino}`.
  Los `err` se reintentan siempre; los `ok` caducan a los `SHIPPING_GROUP_STATE_TTL_DAYS` días (30), porque
  `ACCEPTED` no garantiza aplicado y un `ok` eterno dejaría el SKU barato con envío gratis para siempre.

## 4. Qué hace exactamente el PATCH

Un único JSON pointer, nada más:

```json
{
  "productType": "<el del GET del listing, si no hay → PRODUCT>",
  "patches": [{
    "op": "replace",
    "path": "/attributes/merchant_shipping_group",
    "value": [{ "value": "legacy-template-id", "marketplace_id": "A1PA6795UKMFR9" }]
  }]
}
```

Antes de enviarlo se re-lee el listing y se comprueba que (a) el atributo sigue siendo el UUID, (b) el canal
en vivo es FBM —un SKU puede tener `AMAZON_EU` y `DEFAULT` a la vez, basta con que exista `DEFAULT`— y
(c) el precio efectivo en vivo sigue < 35 €. Si algo cambió, se marca `ok` en el estado con el motivo y no
se parchea. Si lo que falla es que **no se pudo leer el precio** (`sin oferta en vivo`), se marca `err`
para reintentarlo: no es una decisión, es una lectura fallida.

El `marketplaceIds` del PATCH es solo `A1PA6795UKMFR9` y cada entrada del atributo lleva su `marketplace_id`,
así que el `replace` no toca la plantilla de ES/FR/IT (mismo patrón que `enforce-price-bounds.ts` sobre
`purchasable_offer`, ya en producción). Aun así, tras la primera tanda conviene comprobarlo en un SKU real
(§5).

**No hace** (y no debe hacer):

- no borra el atributo: `legacy-template-id` es un valor explícito, no un `delete`;
- no toca ofertas FBA;
- no toca precios, stock, imágenes ni ningún otro atributo;
- no escribe fuera de DE.

## 5. Cómo verificar

1. `npm run listing:status -- <SKU>` → la columna `envío` de DE debe decir `legacy-template-id` (antes, el
   UUID; `ausente (plantilla por defecto)` también cobra 3,99 €).
2. Envío real: `Product Pricing API getListingOffers` sobre una oferta propia debe devolver `Shipping 3.99`
   (antes, en el UUID, devolvía `0.00`). Automatizado con `SHIPPING_CHECK=5 npm run shipping:de-check`
   (tarda hasta un par de días en reflejarse: ver §6).
3. Comprobar que el `replace` no ha tocado otros mercados: el mismo `listing:status` de un SKU del lote debe
   seguir mostrando la plantilla que tenía en ES/FR/IT.
4. Repetir la auditoría con un informe **nuevo** (el maestro tarda en reflejarlo; el CSV local se queda
   viejo, y por eso el estado local es lo que evita repetir PATCH).
5. `ACCEPTED` **no** significa aplicado: si al día siguiente el SKU sigue en el UUID en el informe, mirar
   `issues` del listing (`npm run listing:status`) y la sección siguiente. El estado lo reintenta como muy
   tarde a los `SHIPPING_GROUP_STATE_TTL_DAYS` días; para forzarlo antes, borrar su entrada (o el fichero
   entero) del estado.
6. Verificador: `VERIFY_SAMPLE=100 npm run verify:de-shipping-group` (o `VERIFY_SAMPLE=0` para todos los FBM).
   Sale con código 1 solo si hay violaciones (FBM + efectivo < 35 € + atributo = UUID gratis) o lecturas
   ilegibles. Una plantilla que no sea ninguna de las dos se lista como `REVISAR` (no es violación y el
   corrector no la toca).

## 6. Verificación del envío del comprador (al día siguiente)

El verificador de §5 mira el **atributo**; esta comprobación mira lo que Amazon **cobra de verdad** en la
oferta (`Product Pricing API`, `GET /products/pricing/v0/listings/{sku}/offers`, campo `Shipping` de la
oferta propia FBM). Son dos cosas distintas y hay que mirar las dos: el atributo puede estar perfecto y el
comprador seguir viendo **0,00 €** porque Amazon recalcula el envío del offer **con retraso**.

**Latencia esperada.** En el lote de 5.698 SKU del 26/10 (`*DCI`/`*SGI`) el `Shipping` tardó **hasta un par
de días** en pasar de 0,00 a 3,99 €. Dos horas después del PATCH del 2026-11-04 los 4.852 SKU de
`de_shipping_group_aplicados.csv` seguían a 0,00 € (5/5 medidos). Por eso el paso es **a las 24 h y, si
sigue a 0,00, a las 48 h**, no antes: repetirlo cada hora no adelanta nada y gasta rate limit.

```bash
cd backend

# 5 SKU al azar de los ya parcheados (por defecto lee ../de_shipping_group_aplicados.csv)
SHIPPING_CHECK=5 npm run shipping:de-check

# comprobación del día siguiente, más ancha
SHIPPING_CHECK=100 npm run shipping:de-check

# ¿un SKU concreto? (el CSV acumulado es la fuente por defecto; para forzar otra lista:)
SHIPPING_CHECK_SOURCE_CSV=../mis_skus.csv SHIPPING_CHECK=50 npm run shipping:de-check
```

Qué imprime, por SKU: **precio**, **`Shipping`** y veredicto (`✔ cobrando` / `✗ aún 0,00` / `sin-oferta` /
`solo-fba`), y al final el resumen `n/m ya cobran, k siguen a 0,00`. Detalle completo en
`de_shipping_group_shipping_check.csv` (raíz, gitignored) con `at,sku,precio,shipping,veredicto,detalle`.

- **Solo lee**: ningún PATCH. Se puede lanzar en producción sin miedo.
- Va **secuencial y con pausa** (`SHIPPING_CHECK_PAUSE_MS`, 1000 ms) porque el endpoint va a ~0,5 req/s;
  los `429`/`5xx` se reintentan con backoff (2/4/8 s, `SHIPPING_CHECK_RETRIES`) además de los reintentos
  del cliente.
- Se leen SKU hasta **juzgar** `n` (`SHIPPING_CHECK_MAX_TRIES`, por defecto `5n`): muchos de los parcheados
  están `Inactive` y devuelven `NoBuyableOffers` (sin oferta comprable); esos se saltan, no cuentan como
  fallo. En una muestra real salieron ~2 de cada 3 sin oferta comprable, así que con `n=5` hay que contar
  con ~25 lecturas (~1 min a 0,5 req/s + pausa).
- Un SKU **híbrido** devuelve dos ofertas propias (FBA y FBM): se juzga la **FBM**, que es a la que aplica
  la plantilla. La FBA siempre sale con envío 0,00 y no dice nada.
- **Código de salida**: `1` si algún SKU sigue a 0,00 € (o si no se pudo juzgar ninguno: comprobación no
  concluyente), `0` si todos los juzgados ya cobran. Sirve como comprobación del día siguiente en un cron:
  `SHIPPING_CHECK=50 npm run shipping:de-check || avisar`.

### Si a las 24-48 h sigue a 0,00

En este orden, porque cada paso descarta una causa distinta:

1. **¿El atributo está de verdad?** `npm run listing:status -- <SKU>` → la columna `envío` de DE tiene que
   decir `legacy-template-id`. Si dice el UUID, el PATCH no se aplicó (`ACCEPTED` no es aplicado): mirar
   `issues` en la misma salida y reintentar (§7 de rechazos).
2. **¿La lectura es fiable?** Comprobar un **control** que ya estaba en `legacy-template-id` antes del lote
   (p. ej. `22211966CLM`, `27285SGRG`): si ese devuelve `Shipping 3.99`, la API y la cuenta están bien y el
   problema es de los SKU movidos.
3. **¿Es el id de plantilla correcto?** Si el atributo es `legacy-template-id` y el control cobra, pero los
   movidos siguen a 0,00, el valor no está resolviendo a la plantilla de pago en esta cuenta/marketplace.
   Mirar en Seller Central → Configuración → Plantillas de envío el id real de la plantilla de pago 3,99 €
   (y comprobar si `legacy-template-id` apunta a otra cosa). Para **revertir** con el mismo corrector:
   - En `backend/scripts/lib/de-shipping-group.ts` intercambiar los dos identificadores:
     `PAID_SHIPPING_GROUP = "395e11ea-3c51-4820-aa8f-74e6cf2a4e72"` (o el id correcto) y
     `FREE_SHIPPING_GROUP = "legacy-template-id"`. Es el único sitio donde vive "qué plantilla cobra".
   - **Borrar** `backend/data/de-shipping-group-state.json`: tiene los 4.852 SKU marcados `ok` y sin eso el
     corrector los saltaría (el estado bloquea los `ok` 30 días).
   - `npm run audit:de-shipping-group` (plan, no escribe) y luego por tandas:
     `SHIPPING_GROUP_LIMIT=25 npm run fix:de-shipping-group`, después 500, 1000…
   - Volver a medir con `SHIPPING_CHECK=5 npm run shipping:de-check` sobre uno de los movidos.
   - Si el id bueno es un tercero (ni `legacy-template-id` ni el UUID), usar ese literal en
     `PAID_SHIPPING_GROUP` y comprobar antes con **un** SKU de prueba que `Shipping` pasa a 3,99 €.
4. Anotar el caso y la conclusión en §8 (auditoría de referencia) para no volver a dudar de la premisa.

## 7. Rechazos

Los errores van a `de_shipping_group_errores.csv` con el código de Amazon y quedan en el estado local como
`err`, así que se reintentan en la siguiente ejecución (y ocupan hueco del tope mientras sigan ahí). Los
códigos que ya conocemos están en `docs/runbooks/listings-inactivos.md` (§2); los habituales aquí:

| Código / síntoma | Qué significa | Qué hacer |
|---|---|---|
| `NOT_FOUND` | el SKU no existe en DE (oferta borrada) | nada: no hay oferta que mover (se reintenta cada pasada; borrar su entrada del estado si molesta) |
| `SIN_OFERTA` (propio, no de Amazon) | el listing en vivo no tiene `purchasable_offer` (audiencia `ALL`) en DE: no se pudo leer el precio | se reintenta; si es un listing `Incomplete` sin oferta, no hay nada que mover |
| `99022` (`value_with_tax`, "Angebotspreis") | el listing arrastra un `discounted_price` roto | `enforce:price-bounds` / `set_sale_price.py` lo limpian (`withoutStaleSales`) |
| `90220` / `100632` (GPSR) | la ficha tiene errores de cumplimiento | ver runbook de listings inactivos |
| `100632` RAP/EPR | falta registro de productor | Seller Central → Cumplimiento |
| `400` "Invalid Input" con `merchant_shipping_group` | la plantilla no existe en la cuenta o el `productType` no la admite | comprobar la plantilla en Seller Central → Configuración de envío |

Si un SKU se rechaza siempre por un motivo sin arreglo por API, no se automatiza nada más: se anota aquí y
se deja el caso fuera (si molesta en el contador de errores, borrar su entrada del estado).

## 8. Auditoría de referencia

2026-11-04 con el informe pedido ese día (`de_all_listing_report_fresh.tsv`, 32.684 filas): 32.005 FBM y
679 FBA; 23.931 filas en el informe como `GRUPO 0` (pago) y 8.753 como `GRUPO 4` (gratis).

Resultado del script: **4.865 a mover** (exactamente los FBM en `GRUPO 4` con precio de tarifa < 35 €;
2.351 `Active` y 2.514 `Inactive` —mover los inactivos es inocuo y evita que vuelvan gratis—; ninguno en
`blocked_skus.txt`), **27.128 `ok`** (23.356 ya en la plantilla de pago, 3.093 con precio ≥ 35 €, 679 FBA)
y **691 omitidos** (todos `sin precio` en el informe: listings `Incomplete`/sin oferta). Por tramo de
precio: `<10` 66 · `10-20` 2.377 · `20-30` 1.837 · `30-35` 585. Por familia: CLM 2.088, VCI 792, VC 626,
SG 316, SGRG 259, sin sufijo 203, DC 202, SGRI 138, SGR 49, VCO 41, MDRG 38, MD 36, RGCLM 31, RGSG 21, DCI 9.

En esa ejecución los overrides no cambiaron ni un candidato: 49 precios fijos de DE, 0 manuales y 0 ofertas
`rules:sales`, y **ninguna** de las 4.865 filas tenía `precio_efectivo` distinto del de tarifa. Los 104
registros `AMAZON_EU` dentro de `GRUPO 4` quedan fuera (FBA sin oferta FBM, ver §1). Reproducible con
`DE_REPORT_TSV=../de_all_listing_report_fresh.tsv npm run audit:de-shipping-group`.
