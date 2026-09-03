// Contexto do hospital ativo — mesmo padrão já usado em App.tsx pra
// tema/visibilidade de abas (state em localStorage, lido no mount). Todo
// componente que hoje importa SECTOR_MAPPING/SECTORS/ALL_SECTORS direto de
// anomalyDetection.ts/types.ts passa a ler daqui (`useHospital().hospital`),
// pra refletir o hospital selecionado em vez de ficar preso ao atual.
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { HospitalConfig, HOSPITALS, DEFAULT_HOSPITAL_ID, getHospitalById } from './hospitals';

const STORAGE_KEY = 'active_hospital_id';

interface HospitalContextValue {
  hospital: HospitalConfig;
  hospitalId: string;
  setHospitalId: (id: string) => void;
  hospitals: HospitalConfig[];
}

const HospitalContext = createContext<HospitalContextValue | undefined>(undefined);

export function HospitalProvider({ children }: { children: ReactNode }) {
  const [hospitalId, setHospitalIdState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_HOSPITAL_ID;
    } catch {
      return DEFAULT_HOSPITAL_ID;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, hospitalId);
    } catch {
      // localStorage indisponível — segue sem persistir
    }
  }, [hospitalId]);

  const setHospitalId = (id: string) => setHospitalIdState(id);
  const hospital = getHospitalById(hospitalId);

  return (
    <HospitalContext.Provider value={{ hospital, hospitalId, setHospitalId, hospitals: HOSPITALS }}>
      {children}
    </HospitalContext.Provider>
  );
}

export function useHospital(): HospitalContextValue {
  const ctx = useContext(HospitalContext);
  if (!ctx) throw new Error('useHospital() precisa estar dentro de <HospitalProvider>');
  return ctx;
}
