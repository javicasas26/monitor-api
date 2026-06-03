# Monitor de Cambios — API

API backend para el detector de solicitudes. Guarda snapshots en base de datos y registra cada cambio con fecha, hora y usuario.

---

## Deploy en Railway (5 minutos)

### 1. Subir el código a GitHub

1. Ve a [github.com](https://github.com) → **New repository**
2. Nombre: `monitor-solicitudes-api` → **Create repository**
3. En tu computador, abre una terminal en la carpeta del proyecto y ejecuta:

```bash
git init
git add .
git commit -m "primera versión"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/monitor-solicitudes-api.git
git push -u origin main
```

### 2. Crear el proyecto en Railway

1. Ve a [railway.app](https://railway.app) → **Start a New Project**
2. Elige **Deploy from GitHub repo**
3. Conecta tu cuenta de GitHub y selecciona `monitor-solicitudes-api`
4. Railway detecta Node.js automáticamente y empieza a deployar

### 3. Configurar variables de entorno

En Railway, ve a tu proyecto → pestaña **Variables** → agrega estas:

| Variable | Valor |
|---|---|
| `GOOGLE_API_KEY` | Tu API Key de Google Cloud |
| `API_SECRET` | Una clave larga que tú eliges (ej: `mi-clave-secreta-2024`) |
| `ALLOWED_USERS` | Nombres separados por coma (ej: `ana,pedro`) — opcional |

### 4. Obtener la URL pública

Railway te da una URL como `https://monitor-api-production.up.railway.app`.  
Esa es la base de tu API.

---

## Endpoints

Todos los endpoints requieren estos headers:
```
x-api-secret: <tu API_SECRET>
x-user:       <nombre del usuario>
```

### `GET /api/health`
Verifica que la API está corriendo.

---

### `POST /api/load`
Lee la planilla, compara con el snapshot anterior y devuelve los cambios.

**Body:**
```json
{
  "sheetUrl":    "https://docs.google.com/spreadsheets/d/...",
  "sheetName":   "Hoja 1",
  "headerRow":   2,
  "skuKeyword":  "Sku",
  "solKeyword":  "Solicitud"
}
```

**Respuesta:**
```json
{
  "ok": true,
  "isFirstLoad": false,
  "totalRows": 198,
  "summary": { "new": 2, "deleted": 0, "modified": 5, "solicitud": 3 },
  "changes": [...],
  "rows": [...],
  "snapshot": { "savedAt": "...", "savedBy": "ana", "rowCount": 196 }
}
```

---

### `POST /api/snapshot`
Guarda el estado actual como nueva base de comparación.

**Body:**
```json
{
  "sheetUrl": "https://...",
  "sheetName": "Hoja 1",
  "rows": [...]
}
```

---

### `POST /api/accept`
Acepta todos los cambios pendientes y guarda nuevo snapshot en una sola operación.

**Body:** igual que `/snapshot`

---

### `GET /api/log/:clientId`
Historial de cambios de una planilla.

**Query params opcionales:**
- `limit` (default 100)
- `offset` (para paginación)
- `changeType` → `new` / `deleted` / `modified` / `solicitud`
- `sku` → filtra por SKU
- `pending=true` → solo cambios sin aceptar

**Ejemplo:** `GET /api/log/cl_abc123?pending=true&changeType=modified`

---

### `GET /api/log/:clientId/summary`
Conteo rápido de cambios pendientes.

```json
{
  "ok": true,
  "pending": { "new": 2, "deleted": 0, "modified": 5, "solicitud": 3, "total": 10 }
}
```

---

### `GET /api/snapshots/:clientId`
Lista los últimos 20 snapshots guardados.

---

### `DELETE /api/snapshots/:clientId`
Borra todos los snapshots (reset completo).

---

## Conectar el HTML con la API

En el `detector_solicitudes.html`, agrega en la sección de configuración:

```
URL de la API: https://monitor-api-production.up.railway.app
API Secret:    mi-clave-secreta-2024
Tu nombre:     ana
```

El HTML enviará todos los requests a la API en lugar de usar localStorage.

---

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Crear archivo .env
cp .env.example .env
# Edita .env con tus valores

# Correr en modo desarrollo (recarga automática)
npm run dev

# Correr en producción
npm start
```

---

## ¿Qué guarda la base de datos?

**Tabla `snapshots`:** cada vez que guardas o aceptas cambios, queda registrado quién lo hizo y cuándo.

**Tabla `change_log`:** cada cambio detectado queda con:
- Fecha y hora exacta de detección
- Usuario que hizo la carga
- SKU afectado
- Tipo de cambio (nuevo / eliminado / modificado / solicitud)
- Antes y después de cada celda que cambió
- Fecha y usuario que aceptó el cambio

Esto te da trazabilidad completa de todo lo que pasó en la maestra.
