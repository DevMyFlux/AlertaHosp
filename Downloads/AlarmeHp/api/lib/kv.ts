import { Redis } from '@upstash/redis';

// Vercel nomeia as env vars de forma diferente conforme como o banco Redis
// (Upstash, via Marketplace) foi conectado ao projeto: integração antiga
// "Vercel KV" usa KV_REST_API_*, a integração atual do Marketplace usa
// UPSTASH_REDIS_REST_*. Aceita as duas pra não depender de qual delas o
// dashboard gerou.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const kvConfigured = Boolean(url && token);

// Só instancia o client se as credenciais existirem — evita lançar na
// importação do módulo em ambientes (ex: dev local sem banco configurado)
// onde /api/cron-check nem vai ser chamado.
export const redis = kvConfigured ? new Redis({ url: url!, token: token! }) : null;
