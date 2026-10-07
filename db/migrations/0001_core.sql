-- 0001_core — unidades, setores, leituras, configuração operacional.
--
-- Garantia central: HCN e HMB nunca se misturam. Toda tabela que referencia um
-- setor também carrega unit_id e usa FK COMPOSTA (sector_id, unit_id) →
-- sectors(id, unit_id): o banco recusa gravar uma leitura/alerta cujo setor é
-- de outra unidade.

CREATE TABLE units (
  id                    smallserial PRIMARY KEY,
  code                  text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name                  text        NOT NULL,
  timezone              text        NOT NULL DEFAULT 'America/Sao_Paulo',
  expected_interval_min smallint    NOT NULL CHECK (expected_interval_min BETWEEN 1 AND 120),
  -- estimativa de mercado enquanto a tarifa real do contrato não é informada
  tariff_brl_per_kwh    numeric(8,4) NOT NULL DEFAULT 0.75 CHECK (tariff_brl_per_kwh > 0),
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sectors (
  id                serial      PRIMARY KEY,
  unit_id           smallint    NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  code              text        NOT NULL,
  source_column     text        NOT NULL,
  name              text        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('critico', 'infra', 'imagem', 'hvac')),
  monitored         boolean     NOT NULL DEFAULT true,
  related_hvac_code text,
  display_order     smallint    NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, code),
  UNIQUE (unit_id, source_column),
  UNIQUE (id, unit_id)          -- alvo das FKs compostas
);

CREATE TABLE readings (
  sector_id     integer          NOT NULL,
  unit_id       smallint         NOT NULL,
  ts            timestamptz      NOT NULL,
  -- crus (o que a fonte mandou)
  counter_kwh   double precision,
  quality       smallint,
  -- derivados da normalização (podem ser recalculados)
  status        text             NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'baseline', 'ok', 'gap', 'stale_gap', 'quarantined', 'invalid', 'reset')),
  delta_kwh     double precision,
  interval_kwh  double precision,
  span_minutes  double precision,
  flags         text[]           NOT NULL DEFAULT '{}',
  source        text             NOT NULL DEFAULT 'sheet',
  ingested_at   timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (sector_id, ts),
  FOREIGN KEY (sector_id, unit_id) REFERENCES sectors (id, unit_id) ON DELETE RESTRICT
);
CREATE INDEX readings_unit_ts_idx ON readings (unit_id, ts DESC);

CREATE TABLE operational_windows (
  id                   serial      PRIMARY KEY,
  unit_id              smallint    NOT NULL REFERENCES units (id) ON DELETE CASCADE,
  key                  text        NOT NULL,
  name                 text        NOT NULL,
  start_min            smallint    NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min              smallint    NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  day_type             text        NOT NULL DEFAULT 'all' CHECK (day_type IN ('all', 'weekday', 'weekend')),
  threshold_multiplier numeric(4,2) NOT NULL DEFAULT 1 CHECK (threshold_multiplier BETWEEN 0.5 AND 3),
  sort_order           smallint    NOT NULL DEFAULT 0,
  active               boolean     NOT NULL DEFAULT true,
  CHECK (start_min < end_min),
  UNIQUE (unit_id, key, day_type)
);

-- Regras e política de notificação, versionadas. unit_id NULL = padrão global.
CREATE TABLE alert_rules (
  id            serial      PRIMARY KEY,
  unit_id       smallint    REFERENCES units (id) ON DELETE CASCADE,
  version       text        NOT NULL,
  rules         jsonb       NOT NULL,
  notify_policy jsonb       NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE UNIQUE INDEX alert_rules_one_active_idx ON alert_rules (COALESCE(unit_id, 0)) WHERE active;

-- Estado do motor por unidade (cursor de avaliação, saúde da fonte).
CREATE TABLE unit_state (
  unit_id                  smallint    PRIMARY KEY REFERENCES units (id) ON DELETE CASCADE,
  last_reading_ts          timestamptz,
  last_evaluated_ts        timestamptz,
  source_status            text        NOT NULL DEFAULT 'unknown' CHECK (source_status IN ('unknown', 'online', 'stale')),
  source_status_changed_at timestamptz,
  last_cycle_at            timestamptz,
  last_cycle_status        text,
  last_cycle_summary       jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Estado de persistência por setor (contadores de leituras consecutivas).
-- O alerta aberto em si vive em `alerts`.
CREATE TABLE sector_state (
  sector_id   integer     PRIMARY KEY REFERENCES sectors (id) ON DELETE CASCADE,
  state       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Cache dos baselines (recalculados periodicamente).
CREATE TABLE sector_baselines (
  sector_id     integer     PRIMARY KEY REFERENCES sectors (id) ON DELETE CASCADE,
  as_of         timestamptz NOT NULL,
  rules_version text        NOT NULL,
  stats         jsonb       NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now()
);
