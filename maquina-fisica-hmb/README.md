# Ingestão de telemetria do HMB (máquina física)

Réplica isolada do pipeline do HCN, apontando pro SQL Server do HMB
(servidores Elipse, banco `hmb2`). Roda **na máquina do HMB** (acesso via
TeamViewer), não neste repositório em produção.

```
SQL Server hmb2 ──(alerta_hmb.py)──► API local :5000/energia
                                          │
                        (enviar_sheets_hmb.py, a cada 15 min)
                                          ▼
                     Planilha Google de TELEMETRIA do HMB
                                          │
                         (Apps Script Trigger.gs, gatilho 15 min)
                                          ▼
              backend  /api/cron-check?hospital=HMB  ──► PostgreSQL (alertas) + WhatsApp
```

Este pipeline **só alimenta a planilha de telemetria**. Detecção de anomalia
e disparo de alerta são do backend (motor V2, PostgreSQL); o Apps Script (`apps-script/Trigger.gs`) só agenda o ciclo a cada 15 min.

---

## Arquivos

| Arquivo | O quê |
|---|---|
| `config.example.py` | Modelo. Copie pra `config.py` e preencha (banco, planilha, OAuth). `config.py` **não** vai pro Git. |
| `alerta_hmb.py` | API FastAPI local. Lê `hmb2.dbo.Totalizadores_Disjuntores` e expõe `/energia`. |
| `enviar_sheets_hmb.py` | Lê a API e insere os registros novos no topo da planilha de telemetria. Tem retry + lock de execução única. |
| `rodar_sync_hmb.bat` | Sobe a API se preciso e roda o `enviar_sheets_hmb.py`. Chamado pelo Agendador. |
| `AlertaHosp-HMB-Sync.xml` | Tarefa do Agendador do Windows (15 min + no boot + restart on failure). |

**Planilha do HMB** (uma só, `1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc`):
aba `Telemetria` (leituras de consumo, escrita por este pipeline). A aba
`EstadoAlertas` é do motor antigo (V1): ficou como arquivo histórico — os
alertas passaram a viver no PostgreSQL (ver `docs/03-migracao-postgres.md`).

---

## Passo a passo de instalação (na máquina do HMB)

### 0. Antes de tudo — verificar o que já existe
Abra o **Agendador de Tarefas** e procure por tarefas relacionadas a energia,
sync, planilha, `alerta`, `python`. Se já houver algo do tipo (de um teste
anterior), anote/desative antes de criar a nova — não deixe duas rodando.

> Referência (HCN): a tarefa lá se chama `\CZGM_SyncEnergia`, roda
> `rodar_sync.bat` **a cada 15 min**, indefinidamente, como o usuário local
> `CCO` em "logon interativo", com timeout de 10 min. Não tem BootTrigger
> nem restart-on-failure. O `AlertaHosp-HMB-Sync.xml` replica isso e
> adiciona esses dois. Verificado 2026-09-10 (última execução do HCN =
> resultado 0).

### 1. Python + dependências
Python 3 já está na máquina (confirmado, `py --version`). Instale as libs:
```
py -m pip install fastapi "uvicorn[standard]" pyodbc requests gspread google-auth-oauthlib
```
O driver **ODBC Driver 17 for SQL Server** já está instalado (confirmado).

### 2. Conta de acesso ao banco (NÃO usar `sa`)
O acesso que veio é nível administrador. Peça pra TI do HMB criar um login
SQL só de leitura na tabela de totalizadores, por exemplo:
```sql
CREATE LOGIN alertahosp_ro WITH PASSWORD = '<senha forte>';
USE hmb2;
CREATE USER alertahosp_ro FOR LOGIN alertahosp_ro;
GRANT SELECT ON dbo.Totalizadores_Disjuntores TO alertahosp_ro;
```
Use esse usuário/senha no `config.py`.

### 3. Aba de TELEMETRIA do HMB (na planilha de alertas, não é planilha nova)
> Centralizado: a MESMA planilha dos alertas do HMB
> (`1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc`) ganha uma aba
> `Telemetria`, separada da aba `EstadoAlertas`. As duas não conflitam — o
> Apps Script só toca `EstadoAlertas` (pelo nome), este script só toca
> `Telemetria` (pelo gid).

1. Abra a planilha `1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc`.
2. Crie uma aba nova chamada **`Telemetria`**. Deixe vazia — o
   `enviar_sheets_hmb.py` cria o cabeçalho na 1ª execução.
3. Com a aba `Telemetria` aberta, anote o **gid** (na URL, `…#gid=NUMERO`).
4. Compartilhe a **planilha** → **"Qualquer pessoa com o link" → Leitor**
   (o backend/front lêem a telemetria por export CSV público; a escrita
   continua autenticada por OAuth e o append/resolve dos alertas continua
   exigindo o `secret`). Isso também deixa a aba `EstadoAlertas` legível
   por quem tiver o link — mesmo nível de exposição que o HCN já tem.
5. No `config.py`: `GID_ABA_TELEMETRIA` = o gid da aba `Telemetria`
   (`ID_PLANILHA_TELEMETRIA` já vem preenchido com o ID dessa planilha).
6. **Me passe o gid** — eu preencho `HMB_SHEET_URL` em
   `src/config/hospitals.ts`
   (`…/d/1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc/export?format=csv&gid=<gid>`).

### 4. OAuth do Google (mesma ideia do HCN)
1. No Google Cloud Console do projeto usado hoje, **APIs e Serviços →
   Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo para
   computador**. Baixe o JSON.
2. Salve o JSON na máquina e aponte `OAUTH_JSON` no `config.py` pra ele.
3. Na 1ª execução do `enviar_sheets_hmb.py`, abre o navegador uma vez pra
   autorizar; o `token_hmb.json` é gerado e reutilizado depois.

### 5. Copiar esta pasta pra máquina
Copie `maquina-fisica-hmb/` inteira pra, por exemplo, `C:\AlertaHosp-HMB\`.
Crie o `config.py` a partir do `config.example.py`.

### 6. Testar manualmente
```
cd C:\AlertaHosp-HMB
py alerta_hmb.py           REM sobe a API; em outro terminal:
curl http://localhost:5000/energia   REM deve devolver JSON com E3TimeStamp + colunas _hmb
py enviar_sheets_hmb.py    REM 1ª vez pede login Google; depois insere as linhas
```
Confira se a planilha de telemetria encheu.

### 7. Agendar (15 min, no boot, restart on failure)
1. Edite `AlertaHosp-HMB-Sync.xml`: troque `C:\AlertaHosp-HMB` pelo caminho
   real e `BRASILIANA\brasiliana` pelo usuário real.
2. **Agendador de Tarefas → Ação → Importar Tarefa… →** selecione o XML.
   Ou, PowerShell como Admin:
   ```
   schtasks /Create /TN "AlertaHosp HMB Sync" /XML "C:\AlertaHosp-HMB\AlertaHosp-HMB-Sync.xml"
   ```
3. Marque **"Executar estando o usuário conectado ou não"** e
   **"Executar com privilégios mais altos"** se o login OAuth exigir.
4. Botão direito na tarefa → **Executar** e confira `logs\sync_AAAAMMDD.log`.

### 8. Logs e falhas
- Cada ciclo escreve em `maquina-fisica-hmb/logs/sync_<data>.log`.
- `enviar_sheets_hmb.py` tem retry (4 tentativas, backoff 5→40s) na API e na
  planilha, e sai limpo se outra execução estiver rodando (lock de arquivo).
- Perda de uma janela não perde dado: o próximo ciclo reenvia tudo que for
  mais novo que a última linha da planilha.

---

## Diferenças em relação ao HCN (resumo)

| | HCN | HMB |
|---|---|---|
| Driver ODBC | `SQL Server` (antigo) | `ODBC Driver 17 for SQL Server` |
| Credenciais | hardcoded em `alerta.py` (`sa`) | `config.py` (fora do Git), usuário read-only |
| Tabela | `HCN.dbo.Totalizadores_Disjuntores` | `hmb2.dbo.Totalizadores_Disjuntores` |
| Setores | 21 colunas `DJ*/ME_*` | 19 colunas `ME_*_hmb` |
| `E3TimeStamp` → texto | `str(datetime)` | `strftime('%Y-%m-%d %H:%M:%S')` explícito |
| Retry / lock | não | sim |
| Agendamento | não documentado | `AlertaHosp-HMB-Sync.xml` (versionado) |
