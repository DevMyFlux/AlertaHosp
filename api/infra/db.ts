// Acesso ao PostgreSQL.
//
// Tudo no resto do sistema depende só destas interfaces (`Queryable`/`Db`), não
// de `pg`: em produção a implementação é o `pg.Pool`; nos testes é o PGlite
// (PostgreSQL real em WASM), então as migrations e o SQL dos repositórios são
// exercitados de verdade, sem mock.
//
// A string de conexão vem SEMPRE de variável de ambiente (DATABASE_URL) —
// nunca do código, nunca do frontend, nunca de log.

import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Executa um script com vários comandos (migrations). Sem parâmetros. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Executa `fn` numa transação; faz rollback se lançar. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// pg devolve int8/numeric como string; os valores deste sistema cabem em number
// com folga (contadores < 1e8, ids < 2^53), então convertemos já na leitura.
pg.types.setTypeParser(20, v => Number(v)); // int8 (bigint/bigserial)
pg.types.setTypeParser(1700, v => Number(v)); // numeric

export interface PgOptions {
  connectionString: string;
  /** "no-verify" aceita certificado autoassinado (alguns provedores gerenciados). */
  ssl?: 'default' | 'require' | 'no-verify' | 'disable';
  max?: number;
}

class PgQueryable implements Queryable {
  constructor(protected readonly target: pg.Pool | pg.PoolClient) {}

  async query<T = Record<string, any>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.target.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.target.query(sql);
  }
}

class PgDb extends PgQueryable implements Db {
  constructor(private readonly pool: pg.Pool) {
    super(pool);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgQueryable(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // a conexão já caiu; o erro original é o que importa
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgDb(options: PgOptions): Db {
  const ssl =
    options.ssl === 'no-verify' ? { rejectUnauthorized: false } : options.ssl === 'require' ? true : options.ssl === 'disable' ? false : undefined;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    // Serverless: poucas conexões por instância, conexões ociosas liberadas logo.
    max: options.max ?? 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 20_000,
    ...(ssl === undefined ? {} : { ssl }),
  });
  // Erro em conexão ociosa não pode derrubar o processo.
  pool.on('error', () => undefined);
  return new PgDb(pool);
}

/** Máscara para exibir/logar uma connection string sem a senha. */
export function redactConnectionString(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@');
}
