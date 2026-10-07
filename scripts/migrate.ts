// Aplica as migrations e o seed no banco apontado por DATABASE_URL.
//
//   npm run db:migrate
//
// Idempotente: pode rodar a cada deploy. Nunca imprime a senha da conexão.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgDb, redactConnectionString } from '../backend/infra/db.js';
import { loadAppEnv } from '../backend/infra/env.js';
import { migrate } from '../db/migrate.js';
import { seedReferenceData } from '../db/seed.js';

const env = loadAppEnv();
if (!env.databaseUrl) {
  console.error('DATABASE_URL não definida. Coloque-a em .env.local (nunca no Git) e rode de novo.');
  process.exit(1);
}

const db = createPgDb({ connectionString: env.databaseUrl, ssl: env.databaseSsl, max: 1 });
try {
  console.log(`Conectando em ${redactConnectionString(env.databaseUrl)} …`);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  const result = await migrate(db, dir);
  console.log(`Migrations aplicadas agora: ${result.applied.length ? result.applied.join(', ') : '(nenhuma)'}`);
  console.log(`Já aplicadas antes: ${result.alreadyApplied.length}`);
  await db.transaction(tx => seedReferenceData(tx));
  console.log('Dados de referência (unidades, setores, faixas, regras) em dia.');
} catch (error) {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
