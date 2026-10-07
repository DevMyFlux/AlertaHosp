// Entrada da função serverless na Vercel (vercel.json reescreve /api/* para cá).
import { createApp } from '../backend/app.js';
import { buildDeps } from '../backend/bootstrap.js';

export default createApp(buildDeps());
