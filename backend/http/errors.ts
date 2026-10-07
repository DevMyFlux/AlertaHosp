// Erros HTTP explícitos + validação de entrada sem dependências externas.
// Princípio: entrada inválida é 400 com mensagem clara; nunca "cai" em valor padrão
// silenciosamente (a V1 tratava ?hospital= desconhecido como HCN).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { resolveUnitCode, type UnitCode } from '../../core/units.js';
import type { Logger } from '../infra/ports.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Não autorizado', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'Acesso negado', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Não encontrado', code = 'not_found') => new HttpError(404, code, message);
export const unavailable = (message: string, code = 'unavailable') => new HttpError(503, code, message);

/** Envolve um handler async para que rejeições cheguem ao handler de erro. */
export const route =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(res.locals.requestId ?? '');
    if (err instanceof HttpError) {
      if (err.status >= 500) log.error('http.error', { requestId, path: req.path, code: err.code, error: err.message });
      res.status(err.status).json({ error: err.code, message: err.message, requestId });
      return;
    }
    // JSON malformado do express.json()
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Corpo da requisição não é um JSON válido', requestId });
      return;
    }
    // erro inesperado: registra o detalhe, devolve resposta genérica (sem vazar internals)
    log.error('http.unhandled', { requestId, path: req.path, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'internal_error', message: 'Erro interno. Informe o requestId ao suporte.', requestId });
  };
}

// --- validação ---------------------------------------------------------------------------------

export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badRequest(`Parâmetro "${name}" inválido`);
  return v.trim();
}

/** Unidade obrigatória e estrita: HCN | HMB (aceita apelidos legados só onde o chamador permitir). */
export function requireUnit(raw: unknown): UnitCode {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'HCN' || v === 'HMB') return v;
  throw badRequest(`Unidade inválida: use HCN ou HMB`, 'invalid_unit');
}

/** Apelidos antigos do cron (`atual`, vazio ⇒ HCN) — mas valor desconhecido é erro, não HCN. */
export function legacyUnit(raw: unknown): UnitCode {
  const unit = resolveUnitCode(raw);
  if (!unit) throw badRequest('Unidade inválida: use HCN ou HMB', 'invalid_unit');
  return unit;
}

export function intParam(req: Request, name: string, def: number, min: number, max: number): number {
  const raw = queryString(req, name);
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`"${name}" deve ser um inteiro entre ${min} e ${max}`);
  return n;
}

export function enumParam<T extends string>(req: Request, name: string, allowed: readonly T[], def?: T): T | undefined {
  const raw = queryString(req, name);
  if (raw === undefined || raw === '') return def;
  if (!(allowed as readonly string[]).includes(raw)) throw badRequest(`"${name}" deve ser um de: ${allowed.join(', ')}`);
  return raw as T;
}

/** Data/hora ISO ("2026-09-30" ou "2026-09-30T12:00:00Z"). */
export function dateParam(req: Request, name: string): Date | undefined {
  const raw = queryString(req, name);
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) throw badRequest(`"${name}" deve ser uma data ISO (AAAA-MM-DD)`);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${name}" não é uma data válida`);
  return d;
}
