# Despliegue gratuito con proveedores reales

Un solo servicio sirve la API y la web (mismo origen). Base de datos externa.

- **Servidor:** Render, plan gratuito (`render.yaml` + `Dockerfile`).
- **Base de datos:** Neon, plan gratuito (PostgreSQL).
- **Coste real:** el hosting es gratis; las llamadas a los modelos las pagas tú a
  cada proveedor. Los topes `MADRE_BUDGET_*` bloquean misiones que los superen.

## Seguridad antes de exponerlo

La app no tiene cuentas de usuario. Por eso el servidor pide una contraseña
compartida (`APP_PASSWORD`, autenticación HTTP Basic: el navegador la pide una
vez y la recuerda; el usuario puede ser cualquiera). En producción el servidor
**se niega a arrancar** si hay claves de proveedores reales y no hay
`APP_PASSWORD`. Usa una contraseña larga: quien la tenga puede gastar tu crédito.

## Pasos

1. **Base de datos.** En neon.tech crea un proyecto y copia la cadena de conexión
   (`postgres://...`). Será `DATABASE_URL`.
2. **Claves.** Crea una clave en el proveedor que quieras (Anthropic, OpenAI o
   Google AI Studio). Ponle un límite de gasto mensual en su panel.
3. **Servidor.** En render.com: New → Blueprint → elige el repositorio. Render
   lee `render.yaml` y te pide los valores marcados como secretos:
   `DATABASE_URL`, `APP_PASSWORD`, y `*_API_KEY` + `*_MODEL` del proveedor
   elegido. No hay modelo por defecto: sin `*_MODEL` el proveedor queda «Sin
   configurar».
4. **Abrir.** Render te da una URL `https://…onrender.com`. Ábrela en el iPhone,
   escribe la contraseña y, en Safari, «Compartir → Añadir a pantalla de inicio».
5. **Comprobar.** En la app, sección de proveedores: lanza el chequeo de salud
   (`POST /api/madre/providers/health`, no consume crédito). Después ejecuta una
   misión pequeña y mira el coste en el panel.

## Límites del plan gratuito

- El servicio se duerme tras ~15 min sin visitas y tarda cerca de un minuto en
  despertar. Con la pestaña abierta, el sondeo de la app lo mantiene despierto.
- La cola de ejecución es del propio proceso: si el servicio se reinicia a mitad
  de misión, esa ejecución queda `failed` y se relanza a mano.
- Neon gratuito suspende la base tras un rato inactiva; la primera petición tarda
  un poco más.

## Probar en local igual que producción

```bash
pnpm build
NODE_ENV=production PERSISTENCE=memory APP_PASSWORD=prueba node apps/server/dist/main.js
# http://localhost:3001  (usuario: cualquiera, contraseña: prueba)
```
