-- 0002_alerts — alertas (incidentes), linha do tempo explicável, notificações, auditoria.

CREATE TABLE alerts (
  id                   bigserial        PRIMARY KEY,
  unit_id              smallint         NOT NULL,
  sector_id            integer          NOT NULL,
  kind                 text             NOT NULL DEFAULT 'consumption' CHECK (kind IN ('consumption')),
  status               text             NOT NULL CHECK (status IN ('open', 'recovered')),
  -- severidade atual e pico; NULL só em linhas importadas do legado (V1 não guardava severidade)
  severity             text             CHECK (severity IN ('atencao', 'alto', 'critico')),
  peak_severity        text             CHECK (peak_severity IN ('atencao', 'alto', 'critico')),
  window_key           text             NOT NULL,
  window_name          text             NOT NULL,
  opened_at            timestamptz      NOT NULL,
  severity_changed_at  timestamptz      NOT NULL,
  last_breach_at       timestamptz      NOT NULL,
  recovered_at         timestamptz,
  breach_count         integer          NOT NULL DEFAULT 0,
  peak_value_kwh       double precision NOT NULL DEFAULT 0,
  baseline_kwh         double precision NOT NULL DEFAULT 0,
  peak_pct_over        double precision,
  total_excess_kwh     double precision NOT NULL DEFAULT 0,
  total_cost_brl       numeric(14,2)    NOT NULL DEFAULT 0,
  tariff_brl_per_kwh   numeric(8,4)     NOT NULL,
  rules_version        text             NOT NULL,
  last_notified_at     timestamptz,
  last_notified_severity text           CHECK (last_notified_severity IN ('atencao', 'alto', 'critico')),
  notification_count   integer          NOT NULL DEFAULT 0,
  -- legado: linhas importadas da planilha EstadoAlertas, preservadas e marcadas
  origin               text             NOT NULL DEFAULT 'engine' CHECK (origin IN ('engine', 'legacy_import')),
  suspect              boolean          NOT NULL DEFAULT false,
  suspect_reason       text,
  legacy_payload       jsonb,
  created_at           timestamptz      NOT NULL DEFAULT now(),
  updated_at           timestamptz      NOT NULL DEFAULT now(),
  FOREIGN KEY (sector_id, unit_id) REFERENCES sectors (id, unit_id) ON DELETE RESTRICT,
  CHECK ((status = 'open') = (recovered_at IS NULL)),
  CHECK (origin <> 'engine' OR (severity IS NOT NULL AND peak_severity IS NOT NULL)),
  CHECK (NOT suspect OR suspect_reason IS NOT NULL)
);
CREATE UNIQUE INDEX alerts_one_open_per_sector_idx ON alerts (sector_id) WHERE status = 'open';
CREATE UNIQUE INDEX alerts_legacy_dedupe_idx ON alerts (sector_id, opened_at) WHERE origin = 'legacy_import';
CREATE INDEX alerts_unit_opened_idx ON alerts (unit_id, opened_at DESC);
CREATE INDEX alerts_unit_status_idx ON alerts (unit_id, status);
CREATE INDEX alerts_sector_opened_idx ON alerts (sector_id, opened_at DESC);

-- Linha do tempo do alerta. `explain` guarda tudo que responde "por que disparou?".
CREATE TABLE alert_events (
  id            bigserial        PRIMARY KEY,
  alert_id      bigint           NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  type          text             NOT NULL CHECK (type IN ('opened', 'reopened', 'escalated', 'breach', 'recovered')),
  ts            timestamptz      NOT NULL,
  severity      text             CHECK (severity IN ('atencao', 'alto', 'critico')),
  value_kwh     double precision,
  expected_kwh  double precision,
  limit_kwh     double precision,
  z             double precision,
  pct_over      double precision,
  excess_kwh    double precision,
  explain       jsonb            NOT NULL DEFAULT '{}',
  created_at    timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, ts);

CREATE TABLE notifications (
  id                  bigserial   PRIMARY KEY,
  unit_id             smallint    NOT NULL REFERENCES units (id),
  channel             text        NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  kind                text        NOT NULL CHECK (kind IN ('alert_digest', 'manual', 'test')),
  status              text        NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  suppress_reason     text,
  recipient_masked    text,
  template            text,
  payload             jsonb       NOT NULL DEFAULT '{}',
  provider_message_id text,
  error               text,
  attempts            smallint    NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX notifications_unit_created_idx ON notifications (unit_id, created_at DESC);
CREATE INDEX notifications_status_idx ON notifications (status) WHERE status IN ('queued', 'sending');

-- Um resumo (1 mensagem) cobre N alertas.
CREATE TABLE notification_alerts (
  notification_id        bigint      NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  alert_id               bigint      NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  reason                 text        NOT NULL CHECK (reason IN ('opened', 'escalated', 'reminder', 'recovered')),
  -- estado de notificação do alerta ANTES deste envio: se o envio falhar, é restaurado
  -- e o motor volta a propor o aviso no próximo ciclo
  prev_notified_at       timestamptz,
  prev_notified_severity text        CHECK (prev_notified_severity IN ('atencao', 'alto', 'critico')),
  PRIMARY KEY (notification_id, alert_id)
);
CREATE INDEX notification_alerts_alert_idx ON notification_alerts (alert_id);

-- Eventos da fonte de dados (reinício detectado, fonte parada/retomada, falha de coleta).
CREATE TABLE system_events (
  id         bigserial   PRIMARY KEY,
  unit_id    smallint    NOT NULL REFERENCES units (id),
  ts         timestamptz NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('source_event', 'source_stale', 'source_resumed', 'ingest_error')),
  detail     jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_events_unit_ts_idx ON system_events (unit_id, ts DESC);
CREATE UNIQUE INDEX system_events_dedupe_idx ON system_events (unit_id, kind, ts);

CREATE TABLE ingest_runs (
  id            bigserial   PRIMARY KEY,
  unit_id       smallint    NOT NULL REFERENCES units (id),
  source        text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  rows_received integer,
  rows_new      integer,
  rows_rejected integer,
  status        text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  error         text
);
CREATE INDEX ingest_runs_unit_started_idx ON ingest_runs (unit_id, started_at DESC);

CREATE TABLE audit_log (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text        NOT NULL,
  action    text        NOT NULL,
  entity    text,
  entity_id text,
  detail    jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
