# Extensión Ads: escalado de ganadores SQP

## Objetivo

Preparar campañas Sponsored Products manuales de concordancia exacta para los pares ASIN/término/país priorizados por una tabla de Search Query Performance (SQP).

## Reglas

1. Una cuota de compras SQP superior a la cuota de clics es una señal para priorizar, no una estimación de ACoS ni prueba de que una campaña Ads será rentable.
2. La fuente debe proporcionar el término exacto y el marketplace. Una fila sin término queda `blocked` y no crea una keyword.
3. La creación de campaña queda en simulacro hasta verificar: perfil/marketplace Ads, ASIN anunciado elegible, Buy Box y stock, margen unitario y ACoS observado en la ventana disponible.
4. Puja inicial del simulacro: 0,20 €; techo absoluto: 1,50 €; presupuesto de prueba: 3 €/día por campaña. Estos valores son límites de planificación y no se aplican a Amazon.
5. Antes de activar, comprobar la proyección contra el límite ACoS del 25% por país. Si hay clics Ads del término sin pedidos, no escalar por SQP únicamente; primero validar la ficha/ASIN anunciado y esperar evidencia del ASIN objetivo. Con datos insuficientes, permanecer en pausa.
6. Toda mutación aplicada requerirá `status=approved`, aprobación humana, `ADS_APPLY=1`, idempotencia y asiento en el Change Log.

## Artefacto inicial

`backend/ads/keywords/sqp-winners-2026-10-31.json` contiene las filas transcritas de la tabla. Solo dos filas tienen término explícito. En los informes Ads ES (2026-09-29 a 2026-10-28), los términos suman 4 clics, 1,03 € y cero pedidos en grupos que anunciaban otros ASIN; los dos ASIN objetivo no constan como productos anunciados. B07THDFDM8 registra ACoS del mismo SKU de 51,4% en IT y 39,1% en FR. Por ello el seed sigue en `draft` y no debe activarse todavía. Las otras ocho filas permanecen bloqueadas hasta completar el término exacto. Revisar de nuevo el 2026-11-03, cuando pueda estar disponible una ventana de informe más reciente.
