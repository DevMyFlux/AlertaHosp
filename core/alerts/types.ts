// Vocabulário do motor de alertas.

/** Severidade de um alerta aberto. */
export type Severity = 'atencao' | 'alto' | 'critico';

/** Nível de uma avaliação pontual (inclui "normal"). */
export type Level = 'normal' | Severity;

export const SEVERITIES: readonly Severity[] = ['atencao', 'alto', 'critico'];

export const LEVEL_RANK: Record<Level, number> = { normal: 0, atencao: 1, alto: 2, critico: 3 };

export const SEVERITY_LABEL: Record<Severity, string> = {
  atencao: 'Atenção',
  alto: 'Alto',
  critico: 'Crítico',
};

/** Dia útil × fim de semana. `all` = a janela vale para qualquer dia. */
export type WindowDayType = 'weekday' | 'weekend' | 'all';
