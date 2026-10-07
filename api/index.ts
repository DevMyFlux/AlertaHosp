// Entrada da função serverless na Vercel (vercel.json reescreve /api/* para cá).
import { createApp } from './app.js';
import { buildDeps } from './bootstrap.js';

export default createApp(buildDeps());
