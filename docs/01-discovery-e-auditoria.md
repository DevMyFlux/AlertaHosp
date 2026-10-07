# V2 — Discovery e Auditoria (estado V1, 2026-10-07)

Base: tag `v1-final` (commit `bf0ab57`). Tudo abaixo foi verificado no código e em
dados reais de produção (planilhas de telemetria públicas e `/api/alert-history`),
snapshot em `backups/2026-10-07-pre-v2/` (gitignored).

## 1. Arquitetura encontrada

```
[Máquina física do hospital]            [Google Sheets]              [Vercel]                     [Vonage]
 SQL Server (Elipse/E3)                  aba "Telemetria"             Express (api/app.ts)         WhatsApp template
   └ alerta(.py|_hmb.py) FastAPI  ──►    (contadores acumulados, ──►  /api/cron-check  ──────────► /api/notify
   └ enviar_sheets(.py) a cada 15 min     INSERE no topo, cresce)     React SPA (Vite, dist/)
                                         aba "EstadoAlertas"  ◄────►  Apps Script Web App (Code.gs / Code_HMB.gs)
                                         (estado + histórico)         └ gatilho de 15 min → pingCronCheck → /api/cron-check
```

| Camada | Onde | Observação |
|---|---|---|
| Ingestão | fora deste repo (HCN) / `maquina-fisica-hmb/` (HMB) | Python lê SQL Server e insere em planilha Google |
| "Banco" | Google Sheets (2 abas por hospital) + `localStorage` do navegador | sem schema, sem transação, sem constraint |
| Backend | `api/app.ts` (Express) rodando como função única na Vercel | `/api/notify`, `/api/cron-check`, `/api/alert-history`, `/api/chat`, webhooks Vonage |
| Frontend | `src/` (React 19, Vite 6, Tailwind 4, Recharts) | recalcula anomalias por conta própria a partir do CSV |
| Cron | Apps Script (`pingCronCheck`) → `GET /api/cron-check` | a cada 15 min, um gatilho por hospital |

Tamanho: ~6.700 linhas, 52 arquivos versionados, **0 testes**.

## 2. Fluxo atual dos dados

1. `alerta*.py` expõe os últimos 1000 registros de `Totalizadores_Disjuntores` (contadores **acumulados** de kWh + coluna `_Quality` por setor).
2. `enviar_sheets*.py` insere os registros novos no topo da aba `Telemetria` (HCN: 9.057 linhas / 3,4 MB; HMB: 4.871 linhas / 1,5 MB — cresce ~96 linhas/dia, nunca é podada).
3. **Intervalo de amostragem difere por unidade: HCN = 15 min (timestamps :00/:15/:30/:45); HMB = 10 min (com jitter de segundos, ex.: 10:39:43).** Todo o código V1 assume 15 min (rótulos "15m", `INTERVALS_PER_HOUR = 4`, projeção mensal) — para o HMB a projeção financeira sai 1,5× maior que a realidade.
4. Frontend **e** cron baixam o CSV **inteiro** a cada execução e rodam `processCumulativeData`: consumo do intervalo = `valor(t) − valor(t−1)`; `Quality ≠ 192` → 0; negativo → 0.
5. Nenhum dado é persistido em banco; a "verdade" é a planilha.
6. Falhas de sensor reais já observadas no HMB: `ME_QGBT_E_19`/`E_28` com `Quality=0` por 184 leituras seguidas (19–20/09, ~30 h) e 14 eventos de `Quality=20/0` em todos os setores ao mesmo tempo (reinícios).

## 3. Fluxo atual dos alertas (lógica documentada)

`/api/cron-check` (a cada 15 min) → `buildSectorBandStats` → `detectSectorAnomalies` → `sendAlertNotification` → `recordAlert` (planilha de estado).

| Item | Como é hoje |
|---|---|
| Período/janela | últimas **1000** leituras *positivas* de cada setor **por faixa** (≈19 dias para "Demais Horários", ≈62 dias para "Almoço") |
| Faixas HCN | 4: Café 07–10, Almoço 10–14, Jantar 18–22, "Demais Horários" (13 h misturadas: madrugada+tarde+noite) |
| Faixas HMB (`alertEngineV2`) | 6: acrescenta Madrugada 00–07, Tarde 14–18, Noite 22–24 |
| Média | aritmética da janela |
| Mediana | mediana da janela |
| Moda | arredondamento para **1 kWh** + contagem (péssima para setores de ~1 kWh/intervalo: `central=1.0`) |
| "Valor central" | automático: moda se ≥30% das leituras caem no mesmo balde; mediana se >5% outliers (1,5×IQR) ou \|assimetria\|>1; senão média |
| Limite de disparo | `central × (1 + margem)`; margem = 20% (padrão), sobrescrita por `localStorage` no navegador ou `ALERT_MARGIN_PCT` no servidor — **dashboard e servidor podem divergir** |
| Condições | `count ≥ 4`, `central > 0`, `val > 5 kWh`, `val > limite` |
| O que é avaliado | **somente a última linha** da planilha (não há cursor: a mesma linha pode ser avaliada 2× se o sync atrasar, ou nunca se o cron pular um ciclo) |
| Zeros | excluídos da base (`val > 0`), mas **zero → leitura seguinte vira um "delta" gigante** (ver §5, causa raiz) |
| Nulos/"-" | `parseNumber` devolve 0 |
| Dia da semana | ignorado |
| Severidade | >70% Crítico, >30% Alto, senão Moderado — **não influencia** o envio: toda anomalia notifica |
| Reenvio HCN | enquanto o setor estiver "ativo" na planilha de estado, não reenvia; fecha quando some da lista |
| Reenvio HMB (v2) | **sem supressão**: todo ciclo de 15 min acima do limite envia WhatsApp novo |
| Reinicialização da fonte | nenhum tratamento |
| Fallback | template do hospital → `sistema_de_alerta` → SMS (SMS desligado no HMB) |

## 4. Tecnologias

React 19 · Vite 6 · Tailwind 4 · Recharts · Express 4 · TypeScript 5.8 · Papaparse · xlsx · Vonage SDK · Gemini SDK (sem uso na UI) · Google Apps Script · Python (FastAPI, pyodbc, gspread) · Vercel · bun.lock.

## 5. Problemas encontrados (ordenados por impacto)

### 5.1 Causa raiz dos falsos positivos — confirmada com dados reais
O contador acumulado **zera por uma leitura e volta** (reinício do Elipse/SQL), com `Quality=192` (bom!).
Exemplo real, HCN 24/09/2026:
```
16:15  DJ7_Oncologia=194925,968 (q192)
16:30  DJ7_Oncologia=-          (q192)   ← reinício: "-", 0 ou outro contador (SADT=24710,9)
16:45  DJ7_Oncologia=194929,015 (q192)   ← delta = 194.929 − 0 = 194.929 kWh
```
O `processor.ts` calcula `194.929 − 0` e o "consumo" de 15 min vira **194.929 kWh**. Consequências medidas:
- 24/09 17:05 BRT: **8 setores alertaram de uma vez** (Oncologia 194.928 kWh, Refeitório 675.960 kWh…).
- Esses 8 registros somam **R$ 2.134.792** de "custo desperdiçado" — o histórico inteiro do HCN soma R$ 2.136.725, ou seja, **99,9% do custo exibido no Histórico/XLSX é artefato**; o custo real dos 1.027 alertas restantes é R$ 1.932.
- O mesmo evento ocorreu em 22/07 09:15 e 05/08 11:30 (9 colunas cada) e o valor gigante entra na base estatística (`mean` inflada por semanas).
- Também: lacunas no tempo (ex.: 20/08 16:30→18:15, 105 min) viram um delta de 7 intervalos atribuído a um só.

### 5.2 Volume de alertas — motor atual reproduzido sobre 14 dias reais (replay)
| | Eventos que o motor dispararia | por dia | ciclos de 15 min com ≥1 alerta |
|---|---|---|---|
| HCN (clássico) | 870 | ~62 | 40% |
| HMB (v2, sem supressão) | **2.756** | **~197** | **94%** |

Causas: margem fixa de 20% (CV natural dos setores é maior), nenhuma persistência, nenhuma
histerese, sem cooldown no HMB, setores liga/desliga (Central de Água Gelada 1 = 1.248 eventos)
e um disjuntor (QGBT E-18 = 849) comparados à mediana como se fossem unimodais, um alerta por
setor por ciclo (sem agrupamento).

### 5.3 Segurança
| # | Achado | Gravidade |
|---|---|---|
| S1 | `POST /api/notify` **sem autenticação**: qualquer pessoa na internet pode mandar WhatsApp/SMS para qualquer número com as credenciais Vonage da empresa (custo + abuso) | **Crítica** |
| S2 | `POST /api/chat` sem autenticação consome a chave Gemini; recurso nem aparece mais na UI | Alta |
| S3 | `GET /api/alert-history` público; planilhas de telemetria com link público de export | Média |
| S4 | `CRON_SECRET` do HCN **hardcoded e commitado** em `apps-script/Code.gs` (histórico git) | Alta (rotacionar) |
| S5 | Segredo aceito em `?secret=` (vai pra logs/histórico) e comparado sem tempo constante | Média |
| S6 | Telefone padrão, remetente e namespace do template hardcoded em 5 arquivos | Baixa |
| S7 | Tela de Configurações guarda **chave privada da Vonage em `localStorage`** e a envia no corpo da requisição | Alta |
| S8 | `xlsx@0.18.5`: 2 CVEs altas (prototype pollution, ReDoS), sem correção no npm | Média |
| S9 | `.claude/settings.local.json` (não ignorado pelo git) contém o segredo do HMB | Alta (já ignorado; rotacionar) |
| S10 | `Downloads/AlarmeHp/` dentro do projeto guarda cópias de `.env` | Baixa |
| S11 | login administrador (`sa`) do SQL Server com senha em texto plano no `alerta.py` do HCN (fora do repo) | Alta (fora do escopo do código) |

### 5.4 Confiabilidade / concorrência
- Estado do cron = ler planilha → decidir → gravar (sem transação). O `Code.gs` do HCN não tem `LockService`; dois ciclos sobrepostos duplicam alerta. O deadlock `pingCronCheck`×`doPost` do HMB (commit `bf0ab57`) e a sobrescrita do segredo por `setup()` deixaram o histórico do HMB **sem registros automáticos entre 22/09 e 29/09** (3 linhas no dia 22, 69 no dia 29).
- Notificação enviada, gravação falha → alerta "sumido" no histórico.
- Webhook de status da Vonage só faz `console.warn`: rejeições assíncronas da Meta nunca chegam ao sistema.
- Sem detecção de "fonte parada": se o sync cair, o cron reavalia a mesma linha velha para sempre.
- Frontend mostra `STATUS: OPERACIONAL` fixo e, se a planilha falhar, **cai em dados simulados** (mock) — num monitor hospitalar.

### 5.5 Qualidade de dados no Histórico/relatórios (o problema HCN×HMB)
- `alert_log` do `localStorage` é **global** (não separa hospital). O `HistoryView` agrupa por **nome do setor**: "CME", "Laboratório", "Tomografia", "Raios-X 1" existem nos dois hospitais ⇒ **registros do HCN e HMB se misturam** no resumo/XLSX.
- `LiveMonitorView` registra no log local **toda anomalia exibida** (mesmo sem WhatsApp enviado) e o Histórico soma isso ao remoto.
- Bug: `new Date(d.date + "T" + d.time)` — `date` não existe em `ProcessedTelemetryData` ⇒ cai sempre no primeiro ponto da planilha (consumo "registrado" errado para linhas sem `consumoMedido`).
- XLSX: arquivo `historico_alertas_energia.xlsx` sem unidade/período, sem formatação; **não existe PDF**.
- Rótulos: hospital atual aparece como "Hospital Atual" (id `atual`), HMB como "HMB"; cabeçalho diz "MyFlux"; textos de alerta dizem "Alerta HCN" para os dois.
- KPIs enganosos: "Média por hora" = total ÷ 24 sobre **todo** o CSV (94 dias no HCN); "Consumo total" sem período.

### 5.6 Arquitetura / manutenção
- Regra de negócio duplicada em **frontend e backend** (mesmos módulos, com `localStorage` dentro de `src/lib/*` e `process.env` no mesmo arquivo "isomórfico").
- 3 componentes calculavam estatística própria (já parcialmente unificados), 3 cópias do bloco "montar mensagem + templateParams" (`app.ts`, `LiveMonitorView`, `DiagnosticsView`).
- `anomalyDetection.ts` (674 linhas) mistura estatística, textos de WhatsApp, tipos, mapeamento de setores e config.
- Horários/faixas fixos no código (`getBand`, `BAND_DURATION_HOURS`, `getPeriod`).
- Bug conhecido no nome de coluna: `.ME_CLIM_LAVANDERIA` com ponto (vem do SQL) tratado com `replace` espalhado.
- `any` em ~25 pontos; `tsc` passa (0 erros) porque quase tudo é index signature.
- Bundle único 1,05 MB (320 kB gz); CSV de 3,4 MB baixado a cada carregamento e a cada 15 min por cada aba aberta.
- Dependências sem uso: `jsonwebtoken`, `motion`, `node-fetch`, `tailwind-merge`, `autoprefixer` (+ `@types`); `@vonage/auth` e `@vonage/messages` importados mas **não declarados** (dependência fantasma); `vite` duplicado; `@google/genai`/`react-markdown` só servem a um recurso removido.

## 6. Arquivos/pastas aparentemente desnecessários (confirmados por grep)

| Item | Evidência | Ação |
|---|---|---|
| `src/components/AiChatView.tsx`, rota `/api/chat`, `@google/genai`, `react-markdown`, `GEMINI_API_KEY` | componente não importado em lugar nenhum | remover |
| `HVACView`, `ImagingView`, `DiagnosticsView` | abas pedidas para remoção; sem dependência de backend (só `aggregateByPeriod` usado só por HVACView) | remover |
| `src/data/mockData.ts` + fallback a dados simulados | só usado em `App.tsx`; viola "sem mocks" | remover |
| `metadata.json`, comentários AI Studio no `vite.config.ts` | resquício de template | remover |
| `formatAlertHeader`, `getDiagnosticText`, `formatValorComUnidadeParam`, `calcStats`, `alertStoreConfigured` | 1–2 refs (só a própria definição) | remover |
| `Downloads/AlarmeHp/` | cópia local de `.env`/`.vercel` | **não apago sem confirmação** — listar no relatório |
| deps listadas em §5.6 | sem import | remover |

## 7. Riscos

1. Ligar o V2 sem `DATABASE_URL` derrubaria os alertas → V2 só entra em produção após banco provisionado, backfill e período em *shadow mode* (ver `docs/03-migracao-postgres.md`).
2. Mudança de regra de alerta afeta operação clínica → motor novo precisa de backtest com dados reais (ferramenta `scripts/replay.ts`) e rollout por unidade.
3. Templates WhatsApp aprovados são fixos (9 variáveis): agrupamento e mensagens de sistema precisam caber neles.
4. Dados de produção continuam chegando pela planilha até o script Python ser trocado; o V2 precisa ler a planilha *e* o banco durante a transição.

## 8. Débitos técnicos
Sem testes; sem migrations; sem CI; sem logs estruturados; sem lockfile npm (só `bun.lock`); sem validação de entrada nas rotas; config espalhada em 6 lugares; README vazio.

## 9. Proposta arquitetural V2

Princípios: domínio puro e testável (sem `localStorage`/`process.env`/rede), regra de negócio **só no servidor**, uma tabela de verdade (PostgreSQL), unidade (`HCN`/`HMB`) como cidadã de primeira classe em toda camada.

```
core/                 domínio puro (TypeScript, sem I/O) — importável por api/ e tests/
  units.ts            registro das unidades e setores (fonte única)
  telemetry/          parse + normalização de contadores → intervalos (qualidade, reset, lacuna)
  stats.ts            mediana, MAD, percentis
  alerts/             baseline, detector, ciclo de vida, política de notificação, explicação, mensagens
  report/             modelo de relatório + validação de integridade por unidade
api/                  Express (rotas finas) + services + infra (pg, planilha, Vonage, logger)
db/migrations/        SQL versionado (units, sectors, readings, alerts, alert_events, notifications, …)
scripts/              replay (backtest), migrate-legacy, migrate (runner)
src/                  SPA: roteador por unidade (/#/HCN/…), seletor HCN|HMB sempre visível
tests/                node:test + tsx; PGlite para testar SQL de verdade
docs/
```

Motor de alertas V2 (detalhe em `docs/02-motor-de-alertas-v2.md`): normalização com *quality gate* → baseline robusto (mediana/MAD, por faixa operacional configurável × tipo de dia) → nível por z-score robusto + piso percentual/absoluto + envelope de percentil → persistência → ciclo de vida (abre, escala, recupera) → política (severidade × cooldown × lembrete × agrupamento) → explicação gravada por evento.

## 10. Ordem recomendada de implementação
1. Backup/branch ✔ → 2. núcleo de domínio + testes (normalização, estatística, motor) → 3. replay com dados reais para calibrar → 4. migrations + repositórios (PGlite) → 5. orquestrador do ciclo + rotas + segurança → 6. migração do legado → 7. relatórios PDF/XLSX → 8. frontend → 9. QA/regressão/performance → 10. limpeza e documentação.
