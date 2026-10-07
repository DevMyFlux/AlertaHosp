// Servidor de demonstração local: banco PGlite carregado por `npm run dev:seed` e relógio fixado logo
// depois da última leitura do snapshot de dados reais (backups/2026-10-07-pre-v2), para o painel
// aparecer como se estivesse "ao vivo". Nunca usar em produção (server.ts ignora DEV_FAKE_NOW lá).
process.env.DEV_FAKE_NOW ??= '2026-10-07T13:41:00Z';
await import('../server.js');
