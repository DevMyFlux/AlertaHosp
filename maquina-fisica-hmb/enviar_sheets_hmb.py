"""
Sincroniza a telemetria do HMB: lê a API local (alerta_hmb.py) e insere os
registros novos no topo da planilha de TELEMETRIA do HMB no Google Sheets.

Equivalente ao enviar_sheets.py do HCN, com as melhorias pedidas na
integração:
  - config em config.py (nada hardcoded);
  - retry com backoff na chamada da API e na escrita da planilha (a rede da
    máquina física é instável) — não perde janela por falha transitória;
  - lock de arquivo (enviar_sheets_hmb.lock) pra impedir DUAS execuções
    simultâneas (o agendador pode disparar de novo antes da anterior
    terminar) — a segunda sai na hora sem tocar na planilha;
  - filtro de "registros novos" idêntico ao do HCN: compara E3TimeStamp
    como texto contra o que já está na linha 2 (o alerta_hmb.py garante o
    formato "YYYY-MM-DD HH:MM:SS", que ordena cronologicamente).

Não dispara alerta nem fala com o backend Vercel — isso é responsabilidade
do Apps Script (gatilho de 15 min -> /api/cron-check?hospital=hmb). Este
script só alimenta a planilha de telemetria.
"""
import os
import sys
import time
import json
from datetime import datetime

import requests
import gspread
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

import config

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
LOCK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enviar_sheets_hmb.lock")
LOCK_STALE_SECONDS = 20 * 60  # lock com mais de 20 min é considerado órfão
MAX_TENTATIVAS = 4
BACKOFF_BASE_SEG = 5


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ── Lock de execução única ──────────────────────────────────────────────
def adquirir_lock():
    if os.path.exists(LOCK_FILE):
        idade = time.time() - os.path.getmtime(LOCK_FILE)
        if idade < LOCK_STALE_SECONDS:
            log(f"Ja existe uma execucao em andamento (lock com {idade:.0f}s). Saindo.")
            sys.exit(0)
        log(f"Lock orfao ({idade:.0f}s) — removendo e seguindo.")
        os.remove(LOCK_FILE)
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))


def liberar_lock():
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


# ── Retry genérico ─────────────────────────────────────────────────────
def com_retry(descricao, fn):
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — queremos pegar qualquer falha transitória
            if tentativa == MAX_TENTATIVAS:
                log(f"{descricao}: falhou definitivamente na tentativa {tentativa}: {e}")
                raise
            espera = BACKOFF_BASE_SEG * (2 ** (tentativa - 1))
            log(f"{descricao}: falha ({e}). Retry {tentativa}/{MAX_TENTATIVAS - 1} em {espera}s.")
            time.sleep(espera)


# ── Google ─────────────────────────────────────────────────────────────
def autenticar():
    creds = None
    if os.path.exists(config.TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(config.TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(config.OAUTH_JSON, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(config.TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return creds


def main():
    log("Iniciando sync de telemetria do HMB...")

    dados = com_retry(
        "GET API /energia",
        lambda: requests.get(config.API_URL, timeout=30).json(),
    )
    if not isinstance(dados, list) or not dados:
        log("API nao retornou registros. Nada a fazer.")
        return
    log(f"{len(dados)} registros recebidos da API.")

    creds = com_retry("Auth Google", autenticar)
    gc = gspread.authorize(creds)
    aba = com_retry(
        "Abrir planilha",
        lambda: gc.open_by_key(config.ID_PLANILHA_TELEMETRIA).get_worksheet_by_id(config.GID_ABA_TELEMETRIA),
    )
    log("Conectado na planilha de telemetria do HMB.")

    cabecalho_atual = com_retry("Ler cabecalho", lambda: aba.row_values(1))
    if not cabecalho_atual:
        com_retry("Criar cabecalho", lambda: aba.append_row(list(dados[0].keys())))
        log("Cabecalho criado.")
        ultimo_timestamp = None
    else:
        timestamps = com_retry("Ler coluna de timestamp", lambda: aba.col_values(1))[1:]
        ultimo_timestamp = timestamps[0] if timestamps else None

    log(f"Ultimo registro na planilha: {ultimo_timestamp}")

    if ultimo_timestamp:
        novos = [r for r in dados if str(r.get("E3TimeStamp", "")) > ultimo_timestamp]
    else:
        novos = dados

    if not novos:
        log("Nenhum registro novo.")
        return

    # Dados vem do mais recente pro mais antigo — insere na linha 2 pra
    # manter o mais recente no topo (mesma convencao do HCN).
    linhas = [list(r.values()) for r in novos]
    com_retry("Inserir linhas", lambda: aba.insert_rows(linhas, row=2))
    log(f"{len(novos)} novos registros inseridos no topo.")


if __name__ == "__main__":
    adquirir_lock()
    try:
        main()
        log("Ciclo concluido.")
    except Exception as e:  # noqa: BLE001
        log(f"ERRO no ciclo: {e}")
        sys.exit(1)
    finally:
        liberar_lock()
