@echo off
REM ====================================================================
REM  Sync de telemetria do HMB — sobe a API local se preciso e roda o
REM  envio pra planilha. Equivalente ao rodar_sync.bat do HCN.
REM
REM  Chamado pelo Agendador de Tarefas do Windows a cada 15 min (ver
REM  AlertaHosp-HMB-Sync.xml e o README desta pasta). NAO agenda a si
REM  mesmo — quem agenda e o Task Scheduler.
REM
REM  A trava de execucao dupla real esta no enviar_sheets_hmb.py (lock
REM  de arquivo). Este .bat so garante que a API esta no ar.
REM ====================================================================
setlocal
cd /d "%~dp0"

set LOGDIR=%~dp0logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\sync_%date:~-4%%date:~3,2%%date:~0,2%.log

echo [%date% %time%] --- inicio --- >> "%LOGFILE%"

REM Usa o launcher "py" (mais confiavel nessa maquina, instalador novo do
REM Python). A porta vem do config.py (API_PORT); ajuste o 5000 aqui se mudar la.
netstat -an | find "0.0.0.0:5000" | find "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    echo [%date% %time%] Subindo API alerta_hmb... >> "%LOGFILE%"
    start "" /B py -m uvicorn alerta_hmb:app --host 0.0.0.0 --port 5000 >> "%LOGFILE%" 2>&1
    timeout /t 8 /nobreak >nul
) else (
    echo [%date% %time%] API ja rodando. >> "%LOGFILE%"
)

echo [%date% %time%] Executando enviar_sheets_hmb.py... >> "%LOGFILE%"
py enviar_sheets_hmb.py >> "%LOGFILE%" 2>&1
echo [%date% %time%] --- fim (exit %errorlevel%) --- >> "%LOGFILE%"

endlocal
