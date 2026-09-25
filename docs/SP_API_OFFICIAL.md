# Recursos oficiales de Amazon SP-API

Este proyecto mantiene su cliente TypeScript propio en `backend/src/spapi/`.
Los recursos oficiales se usan como referencia y herramientas de desarrollo;
no se sustituye el cliente actual automáticamente.

## MCP oficial

Instalado globalmente:

```bash
npm install -g @amazon-sp-api-release/sp-api-dev-mcp
```

Requiere Node.js 22 o superior y un `NPM_TOKEN` de Amazon. Desde `backend/`:

```bash
npm run spapi:mcp:assistant
npm run spapi:mcp:workflow
```

El asistente sirve para consultar documentación y el workflow builder para
diseñar flujos de SP-API. No debe recibir secretos ni refresh tokens en los
prompts.

## Repositorios oficiales

- [selling-partner-api-samples](https://github.com/amzn/selling-partner-api-samples): ejemplos de Listings, Pricing, OAuth, Feeds y RDT.
- [selling-partner-api-models](https://github.com/amzn/selling-partner-api-models): modelos OpenAPI y schemas oficiales para validar payloads.
- [selling-partner-api-sdk](https://github.com/amzn/selling-partner-api-sdk): SDK oficial con implementación JavaScript y rate limiting.

## Criterio para este proyecto

El cliente propio conserva el control sobre LWA, reintentos, rate limiting y
los wrappers tipados. Antes de reemplazarlo por el SDK oficial hay que comparar
los payloads de `Listings Items`, `Product Pricing` y `Feeds`, además de probar
los cuatro marketplaces configurados.
