/**
 * Entrada Express que Vercel suele resolver como `src/app.js` en el bundle.
 * Mantén aquí el `import express` directo y `export default` de la app.
 */
import express from 'express';
import { createApp } from './express-factory';

void express;

const app = createApp();

export default app;
