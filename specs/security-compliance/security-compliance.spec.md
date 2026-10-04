# Especificación SDD: Seguridad, Secretos y Cumplimiento Amazon DPP
**Módulo:** `security-compliance`  
**Estándar:** Amazon Data Protection Policy (DPP) & Acceptable Use Policy (AUP)  
**Versión:** 1.0.0  

---

## 1. Protección de Datos de Clientes de Amazon (PII - Personally Identifiable Information)
1. **Regla de No Persistencia de PII:** Nombres de compradores, direcciones de envío y teléfonos obtenidos en pedidos no deben almacenarse en texto plano en bases de datos a largo plazo salvo que sea estrictamente necesario para la expedición.
2. **Purgado Automático:** Toda información identificable de pedidos debe ser anonimizada o eliminada a los 30 días posteriores a la entrega.
3. **Cifrado en Tránsito y Reposo:** TLS 1.3 para todas las conexiones HTTP y cifrado en base de datos PostgreSQL (`AES-256`).

## 2. Gestión de Credenciales y Secretos
- Prohibición estricta de incluir `LWA_CLIENT_SECRET`, `SP_API_REFRESH_TOKEN` o contraseñas en repositorios Git.
- Carga de secretos mediante variables de entorno validadas con Zod al arrancar la aplicación (`backend/src/config/env.ts`).
