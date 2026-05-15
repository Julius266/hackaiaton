# Estimador Agéntico de Copago y Cobertura
## Guía de Implementación Alineada al Modelo de Negocio

Este documento detalla la estructura y el flujo lógico para el sistema de estimación de copagos, respetando las entidades reales y la arquitectura de servicios definida.

---

## 🏗️ Fase 1 – Estructura de Datos en Notion (Real Model)

Configura las siguientes bases de datos en Notion. Evita IDs artificiales; utiliza los identificadores persistentes indicados.

### 1. PLANES_SEGURO
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Plan | Title (PK) | Ej: `PPO-GOLD-01` |
| Nombre_Plan | Text | |
| Aseguradora | Select | |
| Tipo_Plan | Select | HMO / PPO / EPO / POS |
| Deducible_Anual | Number ($) | |
| Coaseguro_Pct | Number (%) | |
| Max_Bolsillo_Anual | Number ($) | |
| Activo | Checkbox | |

### 2. ESPECIALIDADES
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Especialidad | Title (PK) | Ej: `CARD-01`, `DERM-01` |
| Nombre | Text | |
| Sintomas_Relacionados | Multi-select | |
| Urgencia_Base | Select | |
| Requiere_Referido | Checkbox | |

### 3. HOSPITALES
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Hospital | Title (PK) | Ej: `HOSP-ABC` |
| Nombre | Text | |
| Ciudad | Select | |
| Nivel_Atencion | Select | |
| Activo | Checkbox | |

### 4. PACIENTES
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| Numero_Poliza | Title (PK) | **Identificador Persistente Principal** |
| Nombre_Completo | Text | |
| Plan_ID | Relation → PLANES_SEGURO | |
| Email | Email | |
| Telefono | Phone | |
| Estado | Select | Activo / Inactivo |

### 5. COBERTURAS_ESPECIALIDAD
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Cobertura | Title (PK) | Ej: `PLAN-01:CARD-01` |
| Plan_ID | Relation → PLANES_SEGURO | |
| Especialidad_ID | Relation → ESPECIALIDADES | |
| Copago_Fijo | Number ($) | |
| Coaseguro_Override | Number (%) | |
| Cubierto | Checkbox | |

### 6. HOSPITALES_RED
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Red | Title (PK) | |
| Hospital_ID | Relation → HOSPITALES | |
| Especialidad_ID | Relation → ESPECIALIDADES | |
| Planes_Aceptados | Relation → PLANES_SEGURO | Relación N:N |
| Tarifa_Base | Number ($) | |
| Disponible | Checkbox | |

### 7. CONSULTAS_AGENTE (Entidad Central)
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Consulta | Title (PK) | UUID generado por el backend |
| Numero_Poliza | Relation → PACIENTES | Relación con el paciente |
| Especialidad_Sugerida | Relation → ESPECIALIDADES | Detectada por IA |
| Hospital_Recomendado | Relation → HOSPITALES | Según lógica de red |
| Copago_Estimado | Number ($) | Calculado por Backend |
| Sintoma_Ingresado | Text | |
| Estado_Consulta | Select | Abierta / Finalizada |

### 8. SESIONES_CHAT
| Campo | Tipo Notion | Notas |
|-------|-------------|-------|
| ID_Mensaje | Title (PK) | UUID |
| Consulta_ID | Relation → CONSULTAS_AGENTE | Vinculado a la consulta |
| Rol | Select | user / assistant / system |
| Mensaje | Text | |
| Timestamp | Date (auto) | |

---

## 🔗 Fase 2 – Relaciones Críticas

| Origen | Campo | Destino | Tipo |
|--------|-------|---------|------|
| PACIENTES | Plan_ID | PLANES_SEGURO | N:1 |
| CONSULTAS_AGENTE | Numero_Poliza | PACIENTES | N:1 |
| SESIONES_CHAT | Consulta_ID | CONSULTAS_AGENTE | N:1 |
| COBERTURAS_ESPECIALIDAD | Plan_ID | PLANES_SEGURO | N:1 |
| HOSPITALES_RED | Planes_Aceptados | PLANES_SEGURO | N:N |

---

## 💻 Fase 3 – Arquitectura del Backend (TypeScript)

### Servicios Especializados
Para evitar un `notion.service.ts` gigante, el sistema debe modularizarse en:

- `notion.client.ts`: Configuración base del SDK.
- `patient.service.ts`: Búsqueda por póliza y obtención de plan.
- `specialty.service.ts`: Gestión y búsqueda de especialidades.
- `coverage.service.ts`: Lógica de consulta de copagos y límites.
- `hospital.service.ts`: Búsqueda en red (HOSPITALES_RED).
- `consultation.service.ts`: Orquestación de la entidad CONSULTAS_AGENTE.
- `chat.service.ts`: Persistencia de mensajes en SESIONES_CHAT.

### Interfaces Principales
```typescript
interface Patient {
  numeroPoliza: string;
  nombre: string;
  planId: string;
}

interface Coverage {
  copagoFijo: number;
  coaseguro: number;
  estaCubierto: boolean;
}

interface HospitalRecommendation {
  hospitalId: string;
  nombre: string;
  tarifaBase: number;
}
```

---

## 🔄 Fase 4 – Flujo de Operación (11 Pasos)

1. **Entrada:** Usuario envía síntomas y número de póliza.
2. **Identificación:** Backend busca en `PACIENTES` por `Numero_Poliza`.
3. **Plan:** Obtiene el `PLAN_SEGURO` asociado al paciente.
4. **Clasificación:** La IA analiza síntomas y detecta la `ESPECIALIDAD`.
5. **Cobertura:** Backend consulta `COBERTURAS_ESPECIALIDAD` (Plan + Especialidad).
6. **Red:** Backend consulta `HOSPITALES_RED` (Planes aceptados + Especialidad).
7. **Cálculo:** El Backend (no la IA) calcula copago y cobertura real.
8. **Registro:** Se crea el registro en `CONSULTAS_AGENTE`.
9. **Historial:** Se guardan los mensajes iniciales en `SESIONES_CHAT`.
10. **Respuesta:** La IA genera una explicación amigable basada en los datos técnicos.
11. **Salida:** Respuesta final al frontend.

---

## 🤖 Fase 5 – Interacción IA (Tool Calling)

La IA nunca calcula ni consulta Notion directamente. Utiliza estructuras JSON para solicitar datos al backend:

**Ejemplo de solicitud de la IA:**
```json
{
  "intent": "coverage_estimation",
  "specialty": "CARD-01",
  "requiredData": [
    "coverage",
    "network_hospitals",
    "copay"
  ]
}
```

**Responsabilidad del Backend:**
- Ejecuta las consultas reales en Notion.
- Aplica las reglas de negocio (cálculos matemáticos).
- Devuelve el contexto procesado a la IA para su interpretación.

---

## 🚀 Fase 6 – Configuración del Proyecto

```bash
# Instalación de dependencias core
npm install @notionhq/client @anthropic-ai/sdk zod
```

Asegúrate de configurar el `.env` con:
- `NOTION_API_KEY`
- `DATABASE_ID_PACIENTES`
- `DATABASE_ID_CONSULTAS`
- (Resto de IDs de bases de datos)
