// Logs estruturados (uma linha JSON por evento) com redação de dados sensíveis.
//
// Convenção de eventos: substantivo.verbo, ex.: ingest.rejected, alert.opened,
// alert.suppressed, notification.sent, notification.failed, report.generated,
// db.error. Nunca registrar senhas, tokens, chaves ou telefones completos.

import type { Logger } from './ports.js';

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|private|cookie|credential|connection/i;
const PHONE_KEY = /phone|recipient|telefone|whatsapp_to/i;
const URL_WITH_CREDENTIALS = /(\w+:\/\/[^:/\s@]+:)[^@\s]+@/g;

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function redact(value: unknown, key = '', depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (PHONE_KEY.test(key) && typeof value === 'string') return maskPhone(value);
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(URL_WITH_CREDENTIALS, '$1***@').slice(0, 2000);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return value;
}

export interface LogSink {
  log(line: string): void;
}

export function createLogger(sink: LogSink = { log: line => console.log(line) }, base: Record<string, unknown> = {}): Logger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    sink.log(JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact({ ...base, ...fields }) as object) }));
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/** Logger que descarta tudo (testes). */
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
