# Motor de alertas

Objetivo: **menos mensagens, nenhum problema real escondido, e cada alerta explicável.**
Todo o motor é código puro e testado em `core/` (sem rede, sem banco, sem relógio global);
`api/services/cycle.ts` só liga o motor ao banco e ao WhatsApp.

## Pipeline

```
planilha/ingestão ─► 1 Normalização ─► 2 Baseline ─► 3 Detector ─► 4 Ciclo de vida ─► 5 Política ─► WhatsApp
   (contadores)      (quality gate)   (mediana/MAD)  (níveis)     (abre/escala/       (cooldown,
                                                                    recupera)          resumo, teto)
```

### 1. Normalização com quality gate — `core/telemetry/normalize.ts`
O contador é **acumulado** (kWh). O consumo do intervalo é a diferença entre leituras, mas só se a leitura é confiável:

| Situação | Tratamento |
|---|---|
| valor ausente, `-`, ilegível, negativo, `Quality ≠ 192` | `invalid` — **nunca vira 0** (era a causa raiz do incidente de 24/09) |
| contador cai (ex.: 194.929 → 0) | leitura "pendente": se volta ao patamar anterior = glitch descartado; se sobe a partir do valor baixo = reset real, re-baseline |
| queda minúscula (≤ 0,1%, ruído de medidor) | re-baseline, sem consumo atribuído |
| intervalo > 1,25× o esperado | `gap`: consumo normalizado pela taxa |
| intervalo > 3× o esperado | `stale_gap`: guardado, **não avaliável** |
| ≥ 30% dos setores (mín. 3) com problema no mesmo instante | `source_event` (reinício/queda da fonte) + as **2 leituras seguintes ficam em quarentena** (estabilização) |

Intervalo esperado é **por unidade**: HCN = 15 min, HMB = 10 min (a V1 assumia 15 para os dois).
Só leituras `ok` entram em baseline; só `ok`/`gap` são avaliadas.

### 2. Baseline — `core/alerts/baseline.ts`
Por **setor × faixa operacional × tipo de dia** (dia útil/fim de semana), nos últimos 28 dias:
mediana (esperado), σ robusto = MAD × 1,4826, percentis. Mínimo de 24 leituras; abaixo disso o setor está
"aprendendo" e não alerta. Cai para o agregado da faixa se o tipo de dia tem pouca amostra.
Recalculado a cada 6 h e guardado em `sector_baselines` (não é recalculado a cada ciclo).

**Faixas operacionais** (`operational_windows`, editáveis por unidade; padrão calibrado na curva real de HCN e HMB):
Madrugada 00–06 · Troca de turno 06–08 (tolerância ×1,15) · Manhã 08–11 · Almoço 11–14 · Tarde 14–18 ·
Troca de turno e jantar 18–21 (×1,15) · Noite 21–24. A leitura das 07:00 pertence à faixa de 06:45–07:00
(ponto médio do intervalo), não à hora cheia.

### 3. Detector — `core/alerts/detector.ts`
Para cada nível, o limite (kWh) é o **maior** entre quatro condições:

1. `mediana + z × σ` (z = 3 / 4,5 / 7 para atenção / alto / crítico);
2. `mediana × (1 + pct)` (+15% / +30% / +50%);
3. `mediana + excesso mínimo` (2 kW de potência média; ≥ 2 degraus em contadores inteiros como os do HMB);
4. **envelope** `P99 da faixa × 1,05` — nada que o setor já fez naquela faixa é anomalia (protege chillers, compressores, autoclaves).

σ nunca é menor que 10% da mediana, 1 kW de potência ou 0,7 degrau do contador.
O resultado carrega todos os números que explicam a decisão e **qual das quatro condições definiu o limite**.

### 4. Ciclo de vida — `core/alerts/lifecycle.ts`
- **Persistência**: 2 leituras consecutivas acima do limite do nível (pico isolado não abre alerta).
- **Abre** no maior nível sustentado; **escala** por nível ou por **duração** (atenção → alto em 6 h; alto → crítico em 12 h);
  nunca desce enquanto aberto.
- **Recupera** após 3 leituras normais; **reabre o mesmo alerta** se voltar em até 90 min (anti pisca-pisca).
- Leitura inválida/quarentena/sem baseline **não muda o estado**: dado ruim não abre nem fecha alerta.
- Cada leitura é avaliada **uma única vez** (cursor `last_evaluated_ts`); mesma linha duas vezes ou ciclo pulado não geram alerta duplicado/perdido.

### 5. Política de notificação — `core/alerts/policy.ts`
| Regra | Padrão |
|---|---|
| Severidade que gera WhatsApp | **Alto** e acima (atenção fica só no painel) |
| Piso econômico | só notifica quando o excesso acumulado do alerta ≥ 10 kWh (≈ R$ 7,50) |
| Cooldown / lembrete | uma mensagem por alerta; lembrete só a cada 6 h (alto) ou 3 h (crítico) |
| Escalonamento | subir de severidade notifica na hora, mesmo dentro do cooldown |
| Agrupamento | **uma mensagem por unidade por ciclo** (resumo), com os demais setores listados; ALTO+ ainda não avisados pegam carona |
| Teto | 6 mensagens/hora/unidade; **crítico nunca é retido** |
| Dado velho | leitura > 45 min não dispara aviso (fonte parada) |
| Falha de envio | o aviso volta para a fila lógica e é reproposto no ciclo seguinte; rejeição assíncrona da Meta (webhook) também |
| Recuperação | registrada; mensagem de recuperação desligada por padrão (custo) |

Todos os números acima vivem em `alert_rules` (versionados, por unidade) — nada hardcoded no fluxo.

## Evidência (dados reais de produção, snapshot de 07/10/2026)

Backtest de 14 dias (`npm run replay`):

| | Antes (motor anterior) | **Agora** |
|---|---|---|
| HCN — eventos de alerta | 870 (≈ 62/dia, 40% dos ciclos) | 8 incidentes · **2 mensagens** (0,1/dia) |
| HMB — eventos de alerta | 2.756 (≈ 197/dia, 94% dos ciclos) | 29 incidentes · **14 mensagens** (1,0/dia, máx. 5) |
| Reinício de 24/09 (HCN) | 8 alertas, R$ 2,1 mi "de custo" | **0 alertas** (evento de fonte detectado; leituras em quarentena) |

Recall com anomalias injetadas (`npm run recall`, +60% / +100% / +200% por 2 h sustentadas): setores estáveis e
relevantes (SADT, Refeitório, Oncologia, Ressonância, HVAC, QGBT) geram **alto/crítico com WhatsApp** a partir de
+60%…+100%; SADT já em +30%. Setores intermitentes ou muito pequenos (Lactário, Ar Comprimido, QGBT E-19, Raios-X,
Central de Água Gelada 2) **só aparecem em desvios grandes** — é o preço do envelope e do piso de 2 kW, escolhido de propósito
(esses setores geravam a maior parte do ruído da V1). `npm run sensitivity` mostra, setor a setor, quanto acima do esperado
vira cada nível.

## Limitações conhecidas (e o que fazer)
- **Equipamento reserva que liga pela primeira vez** (ex.: Central de Água Gelada 2 do HMB) gera um desvio enorme contra
  baseline "desligado". O envelope aprende o patamar "ligado" depois da primeira ocorrência; o piso econômico evita
  mensagem para partidas curtas. Se a equipe quiser, dá para classificar o setor como "reserva" e limitá-lo a atenção.
- **Sazonalidade** (calor) desloca HVAC aos poucos; a janela de 28 dias acompanha com atraso. Se virar problema, encurtar
  `lookbackDays` só para HVAC.
- **Feriados** não são tratados (cairão como fim de semana ou dia útil conforme o calendário).
- **Quedas de consumo** (ex.: UTI sem carga) não geram alerta — o pedido era consumo excedente.
- A severidade é estatística, não de impacto clínico; o piso econômico e o `notifyFrom` ajustam o que vira mensagem.

## Como ajustar com evidência
```bash
npm run replay -- HMB backups/<snapshot>/hmb_tel.csv 14       # volume de mensagens
RULES_JSON='{"levels":{"alto":{"z":4}}}' npm run replay -- HCN …  # testa uma mudança sem editar código
npm run recall -- HMB …                                        # a mudança ainda enxerga problemas reais?
```
Depois grave a regra em `alert_rules` (nova linha com `version` nova; o ciclo passa a usá-la na próxima execução).
