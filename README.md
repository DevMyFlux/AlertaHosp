# Monitor de Energia — alertas de consumo (HCN e HMB)

Monitora o consumo elétrico por setor dos hospitais **HCN** e **HMB**, detecta consumo acima do esperado,
registra cada alerta com a explicação do porquê e avisa a equipe por WhatsApp — sem enviar mensagem à toa.

```
máquina do hospital ─► planilha Google ─► /api/cron-check (a cada 15 min, gatilho do Apps Script)
   (SQL Server)          (Telemetria)         │ normaliza → avalia → alerta → notifica
                                              ▼
                                        PostgreSQL ◄── API (Express, Vercel) ◄── painel (React)
```

## Estrutura
| Pasta | O quê |
|---|---|
| `core/` | domínio **puro e testado**: normalização de contadores, baseline, detector, ciclo de vida, política, mensagens, modelo de relatório |
| `api/` | Express: rotas finas (`routes/`), regras de negócio (`services/`), integrações (`infra/`: PostgreSQL, planilha, Vonage, logs) |
| `db/` | migrations SQL versionadas, executor e seed |
| `src/` | painel (React + Tailwind + Recharts): Visão geral · Setores · Alertas · Configurações; unidade sempre na URL |
| `scripts/` | carga de histórico, migração, backtest (`replay`), recall, sensibilidade |
| `tests/` | 151 testes (`node:test`), com PostgreSQL real em memória e telemetria real do HCN |
| `apps-script/` | `Trigger.gs` — só agenda o ciclo (segredo nas Propriedades do script) |
| `maquina-fisica-hmb/` | ingestão do HMB (Python, roda no hospital) |
| `docs/` | auditoria do estado anterior, motor de alertas, migração PostgreSQL, segurança/QA/pendências |

## Comandos
```bash
npm install
npm test                      # suíte completa (~1 min)
npm run lint                  # tsc strict
npm run dev:seed              # PostgreSQL local (PGlite) carregado com os dados reais do snapshot
npm run dev:demo              # painel local com relógio fixado no snapshot (http://localhost:3000)
npm run dev                   # painel + API (DATABASE_URL no .env.local, ou o banco local do dev:seed)
npm run db:migrate            # migrations + seed no banco de DATABASE_URL
npm run history:load -- --unit HCN --csv … --legacy …   # histórico + legado V1, com reconciliação
npm run replay -- HMB <csv> 14    # quantas mensagens o motor mandaria nos últimos 14 dias
npm run recall -- HMB <csv>       # ele ainda enxerga problemas reais? (anomalias injetadas)
```

## Publicar
Leia **`docs/03-migracao-postgres.md`** (roteiro com modo sombra e volta) e **`docs/04-seguranca-qa-e-pendencias.md`**
(o que rotacionar e o que ainda depende de você). Variáveis em `.env.example`. Publique por Git — não use `vercel deploy`
nesta pasta (o link `.vercel/` local aponta para outro projeto).

## Documentação
1. [Discovery e auditoria do estado anterior](docs/01-discovery-e-auditoria.md) — como funcionava, o que estava errado, com dados reais
2. [Motor de alertas](docs/02-motor-de-alertas.md) — regras, parâmetros, evidência (antes × agora), limitações
3. [PostgreSQL e migração](docs/03-migracao-postgres.md)
4. [Segurança, QA, performance e pendências](docs/04-seguranca-qa-e-pendencias.md)
