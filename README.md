# Estimador Agéntico de Copago y Cobertura para el Paciente

Backend MVP para hackathon construido con Node.js, Express y TypeScript. El proyecto expone una REST API para recibir síntomas, analizar intención médica con IA, consultar datos de Notion, calcular cobertura/copago y devolver una respuesta lista para el frontend.

## Objetivo

Este backend prioriza velocidad de desarrollo, claridad y demo funcional. El diseño evita sobreingeniería y deja la base lista para evolucionar luego con frontend, autenticación y más herramientas de IA.

## Stack

- Node.js
- Express
- TypeScript
- OpenRouter / OpenAI / Gemini
- Notion API

## Endpoints

- `GET /api/health`
- `POST /api/customer/create`
- `POST /api/chat/message`
- `GET /api/chat/history/:customerId`

## Flujo

1. Se crea o reutiliza un `customerId`.
2. El paciente envía síntomas por REST.
3. La IA interpreta intención, especialidad y datos requeridos.
4. El backend consulta Notion si está configurado.
5. El backend calcula cobertura, copago y hospital recomendado.
6. La IA redacta la respuesta final.
7. Se guarda historial y contexto por cliente.

## Requisitos

- Node.js 18 o superior
- npm
- Variables de entorno definidas a partir de `.env.example`

## Instalación

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

## Compilación

```bash
npm run build
```

## Ejemplos de uso

### Healthcheck

```bash
curl http://localhost:3000/api/health
```

### Crear cliente

```bash
curl -X POST http://localhost:3000/api/customer/create \
  -H "Content-Type: application/json"
```

Respuesta esperada:

```json
{
  "success": true,
  "data": {
    "customerId": "cust_...",
    "conversationId": "conv_..."
  }
}
```

### Enviar mensaje

```bash
curl -X POST http://localhost:3000/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust_123",
    "message": "Tengo dolor de pecho y seguro premium"
  }'
```

Respuesta esperada:

```json
{
  "success": true,
  "data": {
    "customerId": "cust_123",
    "analysis": {
      "intent": "hospital_recommendation",
      "specialty": "Cardiología"
    },
    "businessData": {
      "coveragePercent": 0.9,
      "estimatedCopay": 120
    },
    "assistantMessage": "..."
  }
}
```

### Historial

```bash
curl http://localhost:3000/api/chat/history/cust_123
```

## Variables de entorno

Consulta `.env.example` para ver todos los valores soportados.

## Notion

El backend ya está alineado al modelo real de Notion del hackathon:

- `PLANES_SEGURO`
- `ESPECIALIDADES`
- `HOSPITALES`
- `PACIENTES`
- `COBERTURAS_ESPECIALIDAD`
- `HOSPITALES_RED`
- `CONSULTAS_AGENTE`
- `SESIONES_CHAT`

Las variables de entorno usan estos IDs:

- `DATABASE_ID_PLANES`
- `DATABASE_ID_ESPECIALIDADES`
- `DATABASE_ID_HOSPITALES`
- `DATABASE_ID_PACIENTES`
- `DATABASE_ID_COBERTURAS`
- `DATABASE_ID_HOSPITALES_RED`
- `DATABASE_ID_CONSULTAS`
- `DATABASE_ID_SESIONES`

Si no hay credenciales o bases configuradas, el backend puede operar en modo mock para demo local sin bloquear el flujo.

En el chat, `customerId` y `numeroPoliza` se tratan como alias del identificador del paciente.

## Deploy en Vercel (backend)

1. En [Vercel](https://vercel.com), **New Project** → importa el repo y define **Root Directory** como `hackaiaton` (si el repo es monorepo).
2. Copia las variables de tu `.env` al panel **Settings → Environment Variables** (producción como mínimo): `NOTION_TOKEN`, IDs de bases, `JWT_ACCESS_SECRET`, `CORS_ORIGIN`, claves de IA, `TAVILY_API_KEY`, etc.
3. **`CORS_ORIGIN`**: pon la URL del frontend (ej. `https://tu-app.vercel.app`) o `*` solo para pruebas.
4. Tras el deploy, la API queda en `https://<proyecto>.vercel.app/api/...` (mismas rutas que en local).
5. En el frontend (`hackia-front`), define **`VITE_API_URL=https://<proyecto>.vercel.app`** al construir o en el proyecto de Vercel del front.

Notas:

- El plan Hobby limita **duración** de funciones (~10 s); el chat con IA/Notion puede necesitar **Pro** o optimizar. Este proyecto fija `maxDuration: 60` en `vercel.json` (requiere límites compatibles en tu plan).
- La entrada serverless está en `api/index.ts`: se exporta la app Express por defecto (compatible con el runtime de Vercel).
- Prueba rápida tras deploy: `GET https://<proyecto>.vercel.app/api/health`. Si la raíz `/` devuelve 404, es normal: las rutas viven bajo `/api/...`.
- Si ves **FUNCTION_INVOCATION_FAILED**, revisa **Logs** en Vercel y variables (`AI_PROVIDER`, `PORT`, etc.): valores vacíos o inválidos ya no deberían tumbar el arranque gracias al parseo tolerante en `env.ts`.

## Siguientes pasos sugeridos

1. Conectar bases reales de Notion.
2. Ajustar los nombres de propiedades según el esquema final.
3. Integrar el frontend.
4. Cambiar el proveedor de IA con variables de entorno.
