# Segurança, QA, regressão, performance e pendências

## Segurança — achados da auditoria e o que foi feito

| # | Achado (V1) | Situação agora |
|---|---|---|
| S1 | `POST /api/notify` aberto: qualquer pessoa mandava WhatsApp/SMS para qualquer número com as credenciais da empresa | **Removido.** A única ação que envia mensagem fora do ciclo é o teste administrativo: exige senha configurada **e** sessão, 5 chamadas/10 min, registra auditoria |
| S2 | `POST /api/chat` aberto (chave Gemini) | **Removido** (e o SDK/`GEMINI_API_KEY`) |
| S3 | `GET /api/alert-history` público | Leitura do painel protegida por sessão quando `APP_ACCESS_PASSWORD` está definida (hoje opcional para não travar quem usa sem login — **defina-a em produção**) |
| S4 | Segredo do HCN commitado em `apps-script/Code.gs` | Arquivo removido; `Trigger.gs` lê o segredo das Propriedades do script. **O segredo antigo continua no histórico do Git → rotacione** (nova `CRON_SECRET` na Vercel + Propriedade do script) |
| S5 | Segredo em `?secret=` e comparação simples | Só `Authorization: Bearer`; comparação em tempo constante; `?secret=` retorna 401 (teste) |
| S6 | Telefone, remetente e namespace embutidos no código | Telefone: **nenhum padrão**, só `ALERT_PHONE_NUMBERS[_HMB]`. Remetente/namespace do HCN (identificadores públicos da WABA) ficam num bloco único e documentado em `api/infra/env.ts` |
| S7 | Chave privada da Vonage no `localStorage`/corpo da requisição | **Removido**: credenciais só no servidor |
| S8 | `xlsx` com 2 CVEs altas | Substituído por `exceljs` (relatórios agora no servidor) |
| S9 | Segredo do HMB em `.claude/settings.local.json` (não ignorado) | `.claude/` no `.gitignore`; **rotacione `CRON_SECRET_HMB`** (também apareceu em conversas) |
| S10 | `Downloads/AlarmeHp/` com cópias de `.env` dentro do projeto | Não removido (não é meu): **apague/mova** |
| S11 | Login `sa` do SQL Server em texto plano no `alerta.py` do HCN (máquina do hospital, fora deste repo) | Fora do escopo do código; criar usuário somente-leitura, como já recomendado no README do HMB |

Outras proteções novas: headers de segurança + CSP no `vercel.json`; validação estrita de unidade/datas/enums em toda rota
(unidade desconhecida é **400**, nunca "cai" em outro hospital); cookie de sessão `HttpOnly; SameSite=Strict; Secure`;
limite de tentativas de login (bloqueia só falhas); erros 500 sem detalhes internos (só `requestId`); logs com redação de
senha/token/chave/cookie/connection string e telefones mascarados; SQL 100% parametrizado; webhook da Vonage com verificação de assinatura
(`VONAGE_SIGNATURE_SECRET`) e limite de taxa.
`npm audit`: restam 2 avisos moderados em `exceljs → uuid` (afetam apenas `uuid` v3/v5/v6 com buffer; `exceljs` usa v4) — não explorável aqui.

⚠️ **Não faça `vercel deploy` por esta pasta**: `.vercel/project.json` aponta para outro projeto (`alertass_v2`, rootDirectory `Downloads/AlarmeHp`).
Publique por Git (push na `main`).

## QA — cenários pedidos × testes (`npm test`: 151 testes, ~1 min)

| Cenário | Onde é testado |
|---|---|
| leitura normal / semana inteira sem falso positivo | `cycle.test` (144 ciclos HMB, 0 alertas) |
| pico real sustentado → 1 alerta, 1 mensagem, sem repetir, recupera | `cycle.test`, `lifecycle.test` |
| pico isolado | `lifecycle.test`, `cycle.test` |
| valor 0 / null / negativo / `-` / qualidade ruim | `normalize.test`, `parseCounter` |
| dado duplicado / atrasado / fora de ordem | `normalize.test` (parseSheetRows), `cycle.test` |
| queda da fonte e retorno | `cycle.test` (`source_stale`, `stale_gap`, retomada) |
| **reinício da fonte (incidente de 24/09)** | `normalize.test`, `cycle.test`, **`real-data.test` (telemetria real)** |
| falha de sensor em 2 setores por ~30 h (como HMB E-19/E-28) | `normalize.test` |
| banco indisponível | `/api/health` → 503 + `database: error`; rotas → 503 `database_not_configured` (`api.test`) |
| API indisponível / planilha fora do ar | `infra.test` (gviz→CSV→erro), `cycle.test` (`ingest.error` registrado, ciclo não derruba) |
| WhatsApp indisponível | `cycle.test`: falha registrada, aviso **não se perde** e é reenviado |
| várias unidades / vários setores simultâneos | `cycle.test` (HCN+HMB em paralelo; 3 setores → 1 mensagem) |
| troca de turno / faixas | `detector.test` (faixa pelo ponto médio, tolerância da faixa) |
| alteração de regra | `db.test` (regra por unidade sobrepõe a global e herda o resto) |
| geração de PDF e Excel; HCN nunca como HMB | `report.test` (+ `api.test` ponta a ponta) |
| segurança (auth, segredos por hospital, rotas removidas, 429) | `api.test`, `infra.test` |
| integridade no banco (FK composta, alerta aberto único, checks) | `db.test` |

Regressão do que já existia (HCN/HMB, alertas, histórico, dashboard, filtros, PDF/Excel, comunicação, banco): coberto pelas
suítes acima + verificação manual no navegador contra os dados reais (Visão geral, Setores com gaveta/gráfico, Alertas com
linha do tempo e explicação, Configurações, tema claro/escuro, 375 px). O histórico da V1 foi **importado e reconciliado**
(1.035 + 268 linhas, totais batendo), então os números antigos continuam disponíveis — sem os 8 artefatos nos totais.

O backtest (`scripts/replay.ts`) é parte do QA: mede mensagens/dia e recall com anomalias injetadas sobre dados reais antes de
qualquer mudança de regra.

## Performance — medido

| Item | Antes | Agora |
|---|---|---|
| Bytes baixados por ciclo do cron | 3,4 MB (HCN) / 1,5 MB (HMB), crescendo | ≈ 180 KB (300 linhas via gviz) |
| JS inicial do navegador | 1.047 KB (320 KB gzip), tudo junto | 218 KB (69 KB gzip) + gráficos 416 KB (120 KB) sob demanda |
| Navegador baixando a planilha a cada 15 min por aba aberta | sim | não (só `/api`) |
| Estatística recalculada a cada ciclo sobre o histórico inteiro | sim | baselines em cache (6 h); só leituras novas são avaliadas |
| Consultas do painel | N+1 em setores (21 consultas) | 1 consulta de baselines por tela |
| Ciclo completo (21 setores, PGlite em WASM) | n/d | ≈ 0,25 s |

## Pendências e riscos (honestos)

1. **PostgreSQL de produção não foi exercitado**: as credenciais "disponibilizadas separadamente" **não chegaram ao ambiente**.
   Migrations, SQL, ciclo e API foram testados em PostgreSQL real (PGlite 18 em WASM) e o código usa o driver `pg` padrão
   atrás da mesma interface — mas o primeiro `npm run db:migrate` no servidor real é o teste final. Rode-o antes de publicar na `main`.
2. **Mensagens do WhatsApp**: continuam nos templates aprovados (9 variáveis). Mensagens de *sistema* (fonte parada/retomada,
   recuperação) **não** têm template — hoje aparecem no painel e nos logs; para virarem WhatsApp é preciso aprovar um template novo na Meta.
3. **Ajuste fino das regras com a operação**: os padrões foram calibrados nos dados reais, mas "o que merece WhatsApp" é decisão
   do cliente (`notifyFrom`, piso econômico, lembretes). Há instrumentos (`replay`, `recall`, `sensitivity`) para decidir com números.
4. **Edição de faixas/regras pela interface** não foi construída: a estrutura é configurável (tabelas versionadas) e a tela
   mostra os valores; a alteração hoje é por SQL/seed. Também não há cadastro de usuários — só uma senha de equipe.
5. **Biblioteca visual**: o pedido sugeria uiverse/reactbits/21st.dev. Montei um sistema próprio, sóbrio e consistente
   (tokens, tema claro/escuro, cor por unidade) em vez de copiar componentes animados — mais coerente e sem dependência nova.
   O nome de produto "Monitor de Energia" é provisório (uma constante em `Header.tsx`/`Login.tsx`/`index.html`).
6. **Scripts Python da máquina física** (`maquina-fisica-hmb/`, e os do HCN fora deste repo) não foram alterados: continuam alimentando
   a planilha. Credenciais SQL em texto plano no do HCN são dívida a tratar na máquina.
7. Tarifa (R$ 0,75/kWh) é estimativa de mercado; custos são "estimados" em toda a interface e nos relatórios. Informe a tarifa
   real do contrato em `units.tariff_brl_per_kwh`.
8. Fuso e horário de verão: timestamps são interpretados em `America/Sao_Paulo` com cálculo explícito (não dependem do fuso do servidor).
