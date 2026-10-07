// Servidor para desenvolvimento local e para hospedagem própria (a Vercel usa api/index.ts).
//
//   npm run dev     → API + Vite com HMR. Sem DATABASE_URL, usa um PostgreSQL local em WASM
//                     (PGlite, fora da pasta do projeto) — rode `npm run dev:seed` para carregá-lo com
//                     os dados reais exportados.
//   npm start       → API + frontend já compilado (dist/).
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createApp } from './backend/app.js';
import { buildDeps } from './backend/bootstrap.js';
import { loadAppEnv } from './backend/infra/env.js';
import type { Db } from './backend/infra/db.js';

async function start() {
  const env = loadAppEnv();
  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT ?? 3000);

  let localDb: Db | undefined;
  if (!env.databaseUrl && !isProd) {
    // caminho em variável de propósito: o esbuild não empacota (nem avisa sobre) o banco local de desenvolvimento
    const devDbModule = './scripts/lib/pgliteDb.js';
    const { createTestDb, devDbDir } = (await import(devDbModule)) as typeof import('./scripts/lib/pgliteDb.js');
    localDb = await createTestDb({ dataDir: devDbDir() });
    console.log(`[dev] PostgreSQL local (PGlite) em ${devDbDir()} — sem DATABASE_URL`);
  }

  // Demonstração local: congela o relógio logo depois da última leitura do snapshot de dados reais
  const fakeNow = !isProd && process.env.DEV_FAKE_NOW ? new Date(process.env.DEV_FAKE_NOW) : null;
  const deps = buildDeps({ env, ...(localDb ? { db: localDb } : {}), ...(fakeNow ? { now: () => fakeNow } : {}) });
  if (fakeNow) console.log(`[dev] relógio fixado em ${fakeNow.toISOString()} (DEV_FAKE_NOW)`);
  const app = express();
  app.use(createApp(deps));

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.listen(port, () => console.log(`Servidor em http://localhost:${port}`));
}

start().catch(error => {
  console.error('Falha ao iniciar:', error);
  process.exit(1);
});
