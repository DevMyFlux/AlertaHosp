"""
API local de totalizadores de energia do HMB — equivalente ao alerta.py do
HCN, apontando pro SQL Server do HMB (servidores Elipse, banco hmb2, tabela
Totalizadores_Disjuntores).

Diferenças em relação ao alerta.py do HCN:
  - credenciais/driver saem de config.py (não hardcoded aqui);
  - driver "ODBC Driver 17 for SQL Server" (o HCN usa o driver antigo "SQL Server");
  - a query /energia seleciona as 19 colunas de setor reais do HMB
    (descobertas via schema discovery) + as colunas *_Quality;
  - E3TimeStamp é convertido pra string no formato ISO "YYYY-MM-DD HH:MM:SS"
    de forma EXPLÍCITA (strftime), não via str(datetime) — o enviar_sheets
    compara timestamps como texto e esse formato ordena cronologicamente.

Rodar direto:  python alerta_hmb.py     (sobe em API_HOST:API_PORT)
Ou via bat:    rodar_sync_hmb.bat       (sobe com uvicorn na mesma porta)
"""
from fastapi import FastAPI, HTTPException
import pyodbc
import uvicorn

import config

app = FastAPI(title="API de Totalizadores de Energia - HMB (SQL Server Elipse)")

# 19 colunas de setor da tabela hmb2.dbo.Totalizadores_Disjuntores. Cada uma
# tem a companheira <nome>_Quality. ME_ENEL_hmb é a medição de entrada da
# distribuidora (total do prédio) — vai pra planilha junto, mas o app não
# gera anomalia em cima dela (ver src/config/hospitals.ts).
SETORES = [
    "ME_CME_hmb", "ME_TOMO_hmb", "ME_RAIOX01_hmb", "ME_RAIOX02_hmb", "ME_LABOR_hmb",
    "ME_LACTARIO_hmb", "ME_QGBT_E_16_hmb", "ME_QGBT_E_17_hmb", "ME_QGBT_E_18_hmb",
    "ME_QGBT_E_19_hmb", "ME_QGBT_EMERGENCIA_hmb", "ME_AR_COMP_hmb", "ME_VACUO_hmb",
    "ME_COZINHA_hmb", "ME_CAG01_hmb", "ME_CAG02_hmb", "ME_QGBT_E_28_hmb",
    "ME_QGBT_N_30_hmb", "ME_ENEL_hmb",
]

_COLUNAS_SQL = ",\n            ".join(
    [f"[{s}]\n            ,[{s}_Quality]" for s in SETORES]
)

QUERY_ENERGIA = f"""
    SELECT TOP (1000)
             [E3TimeStamp]
            ,{_COLUNAS_SQL}
    FROM [hmb2].[dbo].[Totalizadores_Disjuntores] WITH (NOLOCK)
    ORDER BY [E3TimeStamp] DESC
"""


def get_db_connection():
    try:
        return pyodbc.connect(config.SQL_CONN_STR)
    except pyodbc.Error as e:
        erro_real = str(e)
        print(f"[ERRO DE CONEXAO] {erro_real}", flush=True)
        raise HTTPException(status_code=500, detail=f"Falha na conexao com o SQL Server do HMB: {erro_real}")


def _fmt_ts(valor):
    # E3TimeStamp vem como datetime do pyodbc. Formato fixo YYYY-MM-DD
    # HH:MM:SS — ordena igual cronologicamente, que é o que o
    # enviar_sheets_hmb.py assume ao filtrar "> ultimo".
    if valor is None:
        return None
    try:
        return valor.strftime("%Y-%m-%d %H:%M:%S")
    except AttributeError:
        return str(valor)


@app.get("/")
def home():
    return {"status": "API Online", "hospital": "HMB", "docs": "/docs"}


@app.get("/testar-conexao")
def testar_conexao():
    conn = get_db_connection()
    conn.close()
    return {"status": "OK", "mensagem": "Conexao com o SQL Server do HMB estabelecida."}


@app.get("/energia")
def listar_energia():
    """Ultimos 1000 registros da tabela Totalizadores_Disjuntores do HMB."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(QUERY_ENERGIA)
        colunas = [col[0] for col in cursor.description]
        resultado = []
        for row in cursor.fetchall():
            registro = dict(zip(colunas, row))
            registro["E3TimeStamp"] = _fmt_ts(registro.get("E3TimeStamp"))
            resultado.append(registro)
        return resultado
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"Erro ao consultar o banco do HMB: {str(e)}")
    finally:
        cursor.close()
        conn.close()


@app.get("/energia/ultimo")
def ultimo_registro():
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(QUERY_ENERGIA.replace("TOP (1000)", "TOP (1)"))
        row = cursor.fetchone()
        if not row:
            return {"mensagem": "Tabela vazia."}
        colunas = [col[0] for col in cursor.description]
        registro = dict(zip(colunas, row))
        registro["E3TimeStamp"] = _fmt_ts(registro.get("E3TimeStamp"))
        return registro
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"Erro ao consultar o banco do HMB: {str(e)}")
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    uvicorn.run("alerta_hmb:app", host=config.API_HOST, port=config.API_PORT, reload=False)
