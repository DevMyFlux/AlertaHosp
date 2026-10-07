// Autenticação e proteções HTTP.
//
//  • Endpoints de máquina (cron, ingestão): segredo no header Authorization,
//    comparação em tempo constante, nunca na query string.
//  • Painel: se APP_ACCESS_PASSWORD estiver definida, exige sessão (cookie
//    HttpOnly assinado com HMAC). Sem ela, a leitura segue aberta como na V1 —
//    mas ações que custam dinheiro (mensagem de teste) exigem sessão sempre.
//  • Limite de tentativas no login e no teste de notificação.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppEnv } from '../infra/env.js';
import { forbidden, HttpError, unauthorized } from './errors.js';

const SESSION_COOKIE = 'alertas_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;

/** Compara segredos sem vazar tamanho nem posição da diferença. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Exige `Authorization: Bearer <segredo>` igual a `expected`. Sem segredo configurado, fecha (401). */
export function checkBearer(req: Request, expected: string | null): void {
  if (!expected) throw unauthorized('Segredo não configurado para esta unidade', 'secret_not_configured');
  const provided = bearerToken(req);
  if (!provided || !safeEqual(provided, expected)) throw unauthorized();
}

// --- sessão ------------------------------------------------------------------------------------

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ sid: randomUUID(), exp: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac || !safeEqual(sign(payload, secret), mac)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionSecretOf(env: AppEnv): string | null {
  return env.sessionSecret ?? env.accessPassword; // sem SESSION_SECRET, deriva da própria senha
}

export function isAuthenticated(req: Request, env: AppEnv): boolean {
  const secret = sessionSecretOf(env);
  return !!secret && verifySessionToken(readCookie(req, SESSION_COOKIE), secret);
}

/** Leitura do painel: protegida só se houver senha configurada. */
export function requireViewer(env: AppEnv): RequestHandler {
  return (req, _res, next) => {
    if (env.accessPassword && !isAuthenticated(req, env)) return next(unauthorized('Faça login para acessar', 'login_required'));
    next();
  };
}

/** Ações administrativas/custosas: exigem sessão SEMPRE (e senha configurada). */
export function requireAdmin(env: AppEnv): RequestHandler {
  return (req, _res, next) => {
    if (!env.accessPassword) return next(forbidden('Defina APP_ACCESS_PASSWORD para habilitar ações administrativas', 'admin_disabled'));
    if (!isAuthenticated(req, env)) return next(unauthorized('Faça login para acessar', 'login_required'));
    next();
  };
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

// --- limite de tentativas (em memória por instância; suficiente contra força bruta simples) ---

export interface AttemptLimiter {
  /** lança 429 se a chave já estourou o limite na janela */
  assertAllowed(key: string): void;
  recordFailure(key: string): void;
  reset(key: string): void;
}

export function attemptLimiter(maxFailures: number, windowMs: number): AttemptLimiter {
  const failures = new Map<string, number[]>();
  const recent = (key: string) => {
    const now = Date.now();
    const list = (failures.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  return {
    assertAllowed(key) {
      if (recent(key).length >= maxFailures) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos.');
    },
    recordFailure(key) {
      const list = recent(key);
      list.push(Date.now());
      failures.set(key, list);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

/** Limita ações que custam dinheiro, contando CADA chamada (não só as falhas). */
export function callLimiter(maxCalls: number, windowMs: number): (key: string) => void {
  const hits = new Map<string, number[]>();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length >= maxCalls) throw new HttpError(429, 'rate_limited', 'Muitas chamadas. Aguarde alguns minutos.');
    list.push(now);
    hits.set(key, list);
  };
}

export function clientKey(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
  return first || req.socket.remoteAddress || 'unknown';
}

// --- cabeçalhos e identificação da requisição ------------------------------------------------

export function baseMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', String(res.locals.requestId));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
