export interface RawTelemetryData {
  E3TimeStamp: string;
  [key: string]: string | number; // accommodates dynamic keys like DJ1_Lavanderia, DJ1_Lavanderia_Quality
}

export interface ProcessedTelemetryData {
  timestamp: string;
  time: string;
  hour: number;
  period: 'Madrugada' | 'Manhã' | 'Tarde' | 'Noite';
  [key: string]: number | string; // actual consumption values and quality warnings
}

export const SECTORS = {
  INFRA: [
    'DJ1_Lavanderia', 'DJ7_Oncologia', 'DJ13_Laboratorio', 'DJ40_Refeitorio', 
    'DJ50_CME', 'SADT', 'ME_UTI_QG_E3', 'ME_UTI_QD_IT'
  ],
  IMAGING: [
    'DJ14_Radiologia', 'DJ60_RM', 'DJ61_Tomografia', 'DJ58_RX1', 'DJ59_RX2'
  ],
  HVAC: [
    'ME_CLIM_ONC_A_T', 'ME_CLIM_REF', '.ME_CLIM_LAVANDERIA', '.ME_CLIM_UTI', 
    'ME_CLIM_CC_CO_CME', 'ME_CLIM_EMERGENCIA', 'ME_CLIM_AMBULATORIO', 'ME_CLIM_LABORATORIO'
  ]
};

export const ALL_SECTORS = [...SECTORS.INFRA, ...SECTORS.IMAGING, ...SECTORS.HVAC];
