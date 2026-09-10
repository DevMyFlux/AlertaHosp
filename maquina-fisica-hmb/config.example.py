# Copie este arquivo para  config.py  (mesma pasta) e preencha os valores
# reais. config.py NÃO vai pro Git (ver .gitignore desta pasta) — é onde
# ficam a senha do banco e os caminhos locais da máquina do HMB.
#
# Espelha o que no HCN estava hardcoded dentro de alerta.py / enviar_sheets.py;
# separado num arquivo só pra não vazar credencial no versionado.

# ── SQL Server do HMB (servidores Elipse) ────────────────────────────────
# Driver 17 já instalado na máquina do HMB (confirmado). Encrypt=no +
# TrustServerCertificate=yes são obrigatórios nesse driver ou a conexão cai
# por SSL.
SQL_CONN_STR = (
    "Driver={ODBC Driver 17 for SQL Server};"
    "Server=192.168.15.13,1433;"
    "Database=hmb2;"
    "UID=SEU_USUARIO_DE_LEITURA;"      # NÃO usar 'sa' em produção — ver README
    "PWD=SUA_SENHA;"
    "Encrypt=no;"
    "TrustServerCertificate=yes;"
    "Connect Timeout=10;"
)

# ── API local (alerta_hmb.py) ───────────────────────────────────────────
# Porta em que o alerta_hmb.py sobe e que o enviar_sheets_hmb.py consome.
# Mantida 5000 pra bater com o rodar_sync_hmb.bat. Se a máquina do HMB for a
# MESMA que roda o SQL, "localhost" serve; se for outra máquina na rede, use
# o IP dela.
API_HOST = "0.0.0.0"
API_PORT = 5000
API_URL = f"http://localhost:{API_PORT}/energia"

# ── Planilha de TELEMETRIA do HMB (Google Sheets) ───────────────────────
# Centralizada na MESMA planilha dos alertas do HMB
# (1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc), numa aba "Telemetria"
# separada da aba "EstadoAlertas". Ver README, secção "Planilha de
# telemetria". Cole o gid da aba Telemetria (na URL: #gid=NUMERO).
ID_PLANILHA_TELEMETRIA = "1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc"
GID_ABA_TELEMETRIA = 370261008  # aba "Telemetria"

# ── OAuth Google (mesmo esquema do HCN: conta de usuário, não service acct) ──
# Reaproveite o MESMO oauth_credenciais.json do HCN (client_id/secret
# identificam a aplicação, não o usuário) — copie o arquivo da máquina do
# HCN (lá fica em C:\Users\CCO\OneDrive\Área de Trabalho\oauth_credenciais.json)
# pra cá. O TOKEN_FILE é separado do HCN e é gerado na 1ª execução (abre o
# navegador uma vez pra autorizar com uma conta que edita a planilha).
#
# ATENÇÃO: se a Tela de permissão OAuth desse projeto estiver "Em teste"
# (não "Em produção"), o refresh token expira em 7 dias e o sync para.
# Publique o app pra produção no Google Cloud Console se for o caso.
OAUTH_JSON = r"C:\Users\brasi\oauth_credenciais_hmb.json"
TOKEN_FILE = r"C:\Users\brasi\token_hmb.json"
