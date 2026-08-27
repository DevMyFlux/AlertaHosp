// URL pública (export CSV) da planilha de telemetria — usada tanto pelo
// polling do frontend (src/App.tsx, visão "ao vivo") quanto pelo cron
// server-side (api/app.ts, /api/cron-check) que efetivamente dispara os
// alertas. Extraída pra um módulo só pra não haver duas fontes divergindo.
export const SHEET_URL = "https://docs.google.com/spreadsheets/d/15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs/export?format=csv&gid=681869284";
