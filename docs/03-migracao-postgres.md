# PostgreSQL: modelo, migração sem perda e virada

## O que mudou de lugar

| Dado | V1 | V2 |
|---|---|---|
| Telemetria | só na planilha (3,4 MB / 9 mil linhas no HCN, crescendo sem limite) | tabela `readings` (bruto **e** normalizado, idempotente por `(setor, instante)`) |
| Estado e histórico de alertas | aba `EstadoAlertas` + `localStorage` de cada navegador | `alerts` + `alert_events` (linha do tempo com a explicação de cada decisão) |
| Mensagens | sem registro | `notifications` (+ `notification_alerts`): fila, enviada, falhou, suprimida e por quê |
| Configuração | espalhada no código | `units` (tarifa), `operational_windows`, `alert_rules` (versionadas) |
| Saúde da fonte | inexistente | `unit_state`, `system_events` (reinício/queda/retomada), `ingest_runs` |

Migrations em `db/migrations/` (versionadas, imutáveis — o executor guarda o checksum e **recusa** continuar se uma já aplicada for editada).

**HCN × HMB no banco:** toda tabela que referencia um setor também carrega `unit_id` com **FK composta**
`(sector_id, unit_id) → sectors(id, unit_id)`. O PostgreSQL recusa gravar leitura/alerta cujo setor é de outra unidade
(testado em `tests/db.test.ts`). Existe no máximo **um alerta aberto por setor** (índice parcial único).
Índices: `readings(unit_id, ts desc)`, `alerts(unit_id, opened_at desc)`, `alerts(unit_id, status)`, `alerts(sector_id, opened_at desc)`,
`notifications(unit_id, created_at desc)`.

## Variáveis de ambiente (nada de senha no código)
Ver `.env.example`. Obrigatórias para a V2: `DATABASE_URL` (+ `DATABASE_SSL` se o provedor exigir `no-verify`),
`CRON_SECRET` / `CRON_SECRET_HMB`, credenciais Vonage, `ALERT_PHONE_NUMBERS[_HMB]`, `ALERT_WHATSAPP_FROM[_HMB]`,
`VONAGE_WHATSAPP_TEMPLATE_NAMESPACE[_HMB]`. Recomendadas: `APP_ACCESS_PASSWORD`, `V2_SHADOW_MODE=true` na virada.
Use no banco um usuário só com acesso a este schema (não o administrador). A string de conexão nunca vai ao navegador
(o frontend só fala com `/api`) nem aos logs (redação automática).

## Roteiro de migração (cada passo é reversível até o 6)

1. **Backup** — tag `v1-final` (código) e `backups/2026-10-07-pre-v2/` (CSV das duas planilhas + `/api/alert-history` dos dois hospitais; ignorado pelo Git). A planilha original **não é alterada** em nenhum passo.
2. **Provisionar o banco** e preencher `DATABASE_URL` em `.env.local` (local) e na Vercel (preview primeiro).
3. **Criar a estrutura**: `npm run db:migrate` (idempotente: aplica migrations e o seed de unidades/setores/faixas/regras).
4. **Carregar o histórico** por unidade — telemetria + alertas da V1, com relatório de reconciliação:
   ```bash
   npm run history:load -- --unit HCN --csv backups/2026-10-07-pre-v2/hcn_tel.csv --legacy backups/2026-10-07-pre-v2/hcn_hist.json
   npm run history:load -- --unit HMB --csv backups/2026-10-07-pre-v2/hmb_tel.csv --legacy backups/2026-10-07-pre-v2/hmb_hist.json
   ```
   Não envia mensagens. Reexecutar é seguro (idempotente). O comando sai com erro se as contas não fecharem.
   O primeiro `/api/cron-check` num banco vazio também baixa a planilha inteira sozinho.
5. **Validar** (feito nos dados reais de 07/10/2026, PGlite):

   | | Linhas na origem | Importadas | Suspeitas | Custo na origem | Custo válido | Custo de artefato |
   |---|---|---|---|---|---|---|
   | HCN | 1.035 | 1.035 | 8 | R$ 2.136.724,66 | **R$ 1.932,33** | R$ 2.134.792,15 |
   | HMB | 268 | 268 | 0 | R$ 2.942,76 | R$ 2.942,84 | — |

   As 8 linhas suspeitas são o reinício de 24/09 (excedentes de 114 mil a 790 mil kWh em um único intervalo de 15 min): ficam gravadas para
   auditoria, marcadas `suspect`, **fora dos totais e dos relatórios**. A diferença de centavos entre origem e banco é
   arredondamento para 2 casas do `numeric`.
6. **Modo sombra** — publique o branch `v2` como *preview* na Vercel com `V2_SHADOW_MODE=true`: o motor novo avalia, grava
   alertas e notificações (`suppressed`/`shadow_mode`) mas **não envia**. Compare por alguns dias com o que o motor antigo
   enviou (`/#/HCN/configuracoes` lista as notificações; `npm run replay` dá a expectativa).
7. **Virada** — troque o gatilho do Apps Script para `apps-script/Trigger.gs` apontando para o deploy novo (o endpoint
   `/api/cron-check` e o header `Authorization: Bearer` são os mesmos da V1: o gatilho **atual** já funciona sem alteração).
   Desligue `V2_SHADOW_MODE`. Faça merge de `v2` em `main`.
8. **Monitorar** — `GET /api/health` (banco, idade da última leitura, notificações configuradas por unidade); logs JSON
   (`cycle.done`, `alert.opened`, `source.event_detected`, `notification.failed`…).
9. **Só depois** de uma semana estável: remover o motor antigo/abas `EstadoAlertas` (hoje já não são lidas pela V2).

### Rollback
Antes do passo 7: não houve efeito em produção. Depois: voltar o deploy da Vercel para o commit anterior (`v1-final`) —
a planilha e o gatilho continuam como eram; o banco novo fica intacto. Dados gravados no PostgreSQL nunca são apagados por código.

## Origem dos dados (hoje e depois)
A ingestão continua pela planilha (Python na máquina do hospital → aba `Telemetria`) — **nada muda no hospital**.
O backend lê só as linhas mais recentes via endpoint `gviz` (≈ 180 KB em vez de 3,4 MB por ciclo) e cai para o CSV completo se
falhar. Quando quiserem retirar a planilha da cadeia, o endpoint `POST /api/ingest/<UNIDADE>` (header `Authorization: Bearer <INGEST_KEY[_HMB]>`,
corpo `{"rows":[{...mesmas colunas da planilha...}]}`) aceita as leituras direto da máquina, com a mesma normalização e o mesmo motor.

## Desenvolvimento local sem banco na nuvem
`npm run dev:seed` cria um PostgreSQL local (PGlite, em `%LOCALAPPDATA%/alertas-energia-dev/`) já carregado com os dados reais
do snapshot; `npm run dev:demo` sobe o painel com o relógio fixado logo depois da última leitura. O banco local fica **fora da pasta
do projeto** porque o OneDrive trava os arquivos do banco ("could not create lock file").
