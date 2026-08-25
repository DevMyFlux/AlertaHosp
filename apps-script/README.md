# Configuração do Apps Script (estado do cron + gatilho de 15 min)

Substitui a necessidade de Google Cloud Console/Service Account e de um
pinger externo (cron-job.org). Tudo roda de dentro da própria planilha de
telemetria.

## 1. Escolha o segredo compartilhado

Gere uma string aleatória longa (ex: `openssl rand -hex 32` ou qualquer
gerador de senha). Vai ser usada em dois lugares — precisa ser **exatamente
a mesma** nos dois.

## 2. Colar o script na planilha

1. Abra a planilha de telemetria no navegador.
2. Menu **Extensões > Apps Script**.
3. Apague o conteúdo padrão de `Código.gs` e cole o conteúdo de
   [`Code.gs`](./Code.gs) deste repositório.
4. No topo do script, preencha:
   - `SHARED_SECRET`: o segredo do passo 1.
   - `CRON_CHECK_URL`: a URL de produção do app + `/api/cron-check`
     (ex: `https://alerme-hosp-drs8.vercel.app/api/cron-check`).
5. Salve (ícone de disquete ou Ctrl+S).

## 3. Implantar como Web App

1. No editor do Apps Script, clique em **Implantar > Nova implantação**.
2. Tipo: **App da Web**.
3. Executar como: **Eu** (sua conta, dona da planilha).
4. Quem pode acessar: **Qualquer pessoa**.
5. Clique em **Implantar** e autorize as permissões pedidas (é o seu
   próprio script pedindo acesso à sua própria planilha).
6. Copie a **URL do app da Web** gerada (termina em `/exec`).

## 4. Configurar o gatilho de 15 em 15 minutos

1. Ainda no editor do Apps Script, ícone de relógio (**Gatilhos**) na
   barra lateral esquerda.
2. **Adicionar gatilho**.
3. Função a executar: `pingCronCheck`.
4. Origem do evento: **Baseado em tempo**.
5. Tipo de gatilho baseado em tempo: **Temporizador por minutos** →
   **A cada 15 minutos**.
6. Salvar.

## 5. Configurar as env vars na Vercel

No painel do projeto (Settings > Environment Variables), adicione:

- `SHEETS_WEBAPP_URL`: a URL copiada no passo 3.6 (termina em `/exec`).
- `CRON_SECRET`: o mesmo segredo do passo 1.

Faça um redeploy (ou aguarde o próximo push) pra as env vars entrarem em
vigor.

## Pronto

A partir daqui, a cada 15 minutos o Apps Script chama `/api/cron-check`
sozinho, que busca a planilha de telemetria, detecta anomalias e envia os
alertas — sem depender de nenhum navegador aberto em nenhuma máquina. O
estado (quais setores estão em alerta, histórico de 30 dias) fica na aba
**EstadoAlertas**, criada automaticamente na primeira execução.

Se precisar reimplantar o script depois de editar `Code.gs` (ex: trocar a
URL ou o segredo), use **Implantar > Gerenciar implantações > editar
(ícone de lápis) > Nova versão > Implantar** — só criar uma implantação nova
gera uma URL diferente, então prefira sempre editar a implantação existente.
