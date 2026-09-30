import React, { useState, useMemo, useEffect } from 'react';
import { getAlertLog, LoggedAlert } from '../lib/alertLog';
import { Filter, Search, AlertCircle, FileSpreadsheet, Loader2, FileText, Plus, Pencil, X, Save } from 'lucide-react';
import { formatBRL, calcFinancialImpact } from '../lib/costEstimation';
import * as XLSX from 'xlsx';
import { ProcessedTelemetryData } from '../types';
import { buildSectorBandStats, getAlertMarginPct } from '../lib/anomalyDetection';
import { useHospital } from '../config/HospitalContext';
import { HOSPITALS } from '../config/hospitals';

interface Props {
  data: ProcessedTelemetryData[];
}

function readEntries(key: string): LoggedAlert[] {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function readEdits(key: string): Record<string, LoggedAlert> {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function alertId(log: LoggedAlert) { return (log as LoggedAlert & { id?: string }).id || `${log.loggedAt}|${log.sectorKey}`; }

export function HistoryView({ data }: Props) {
  const { hospital } = useHospital();
  const [localLogs, setLocalLogs] = useState<LoggedAlert[]>(getAlertLog());
  const [remoteLogs, setRemoteLogs] = useState<LoggedAlert[]>([]);
  const [manualLogs, setManualLogs] = useState<LoggedAlert[]>(() => readEntries(`alert_manual_${hospital.id}`));
  const [edits, setEdits] = useState<Record<string, LoggedAlert>>(() => readEdits(`alert_edits_${hospital.id}`));
  const [editing, setEditing] = useState<{ id?: string; log?: LoggedAlert } | null>(null);
  const [form, setForm] = useState({ sectorName: '', loggedAt: '', date: '', time: '', val: '', expectedMax: '', excedenteKwh: '', custoEstimadoBRL: '', severity: 'Atenção' });
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [viewMode, setViewMode] = useState<'resumo' | 'detalhado'>('resumo');
  
  const [sectorFilter, setSectorFilter] = useState<string>('ALL');
  const [daysFilter, setDaysFilter] = useState<number | 'custom'>(30);
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');

  useEffect(() => {
    setLocalLogs(getAlertLog());
    setManualLogs(readEntries(`alert_manual_${hospital.id}`));
    setEdits(readEdits(`alert_edits_${hospital.id}`));
  }, [hospital.id]);

  // O histórico remoto (/api/alert-history) já é multi-hospital no backend
  // (?hospital=<id>). Depende só de a telemetria do hospital existir — sem
  // planilha não há como reconstruir os limiares históricos da tabela. Se o
  // Apps Script daquele hospital ainda não estiver configurado, o endpoint
  // devolve { rows: [] } e a tela mostra "sem histórico" sem quebrar.
  const remoteHistoryAvailable = Boolean(hospital.sheetUrl);

  useEffect(() => {
    let cancelled = false;
    if (!remoteHistoryAvailable) {
      setRemoteLogs([]);
      setLoadingRemote(false);
      return () => { cancelled = true; };
    }
    setLoadingRemote(true);
    // Fetch real backend history from Google Sheets
    fetch(`/api/alert-history?hospital=${encodeURIComponent(hospital.id)}`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`Servidor retornou erro: ${res.status}`);
        }
        return res.json();
      })
      .then(json => {
        if (cancelled || !json || !Array.isArray(json.rows)) return;

        // Isola a leitura mesmo se a ponte/planilha remota tiver sido
        // configurada por engano com linhas de outro hospital.
        const hospitalSectorKeys = new Set(hospital.allSectors.map(key => key.replace(/^\./, '')));
        const hospitalRows = json.rows.filter((row: any) =>
          hospitalSectorKeys.has(String(row.sectorKey || '').replace(/^\./, ''))
        );

        // sStats for historical threshold reconstruction (fallback — só usado
        // quando a linha não tem consumoMedido/consumoReferencia persistidos,
        // ver motor v2 abaixo). Precisa da mesma flag de bandas usada na
        // gravação, senão a banda de r.band não bate com nenhuma chave aqui.
        const sStats = buildSectorBandStats(data, hospital.allSectors, hospital.alertEngineV2);
        const marginPct = getAlertMarginPct();

        const reconstructed: LoggedAlert[] = hospitalRows.map((r: any) => {
          const loggedTime = new Date(r.loggedAt).getTime();
          
          // Find closest telemetry data point to the time the alert was logged
          let closestPoint = data[0];
          let minDiff = Infinity;
          for (const d of data) {
            const dTime = new Date(d.date + "T" + d.time).getTime(); // approximation
            const diff = Math.abs(dTime - loggedTime);
            if (diff < minDiff) {
              minDiff = diff;
              closestPoint = d;
            }
          }

          let val = 0;
          let expectedMax = 0;
          let projecaoMensalBRL = 0;
          // Alguns setores HVAC têm um "." indevido prefixado no nome da coluna
          // real da planilha (bug pré-existente em src/types.ts, fora do escopo
          // desta mudança) — normaliza antes do lookup pra não cair no fallback.
          const sectorName = hospital.sectorMapping[r.sectorKey.replace(/^\./, '')]?.label || r.sectorKey;

          // Excedente/custo já vêm exatos do histórico persistido (gravados no
          // momento real do alerta, junto com a mensagem enviada) — não
          // recalcular.
          const excedenteKwh = Number(r.excedenteKwh) || 0;
          const custoEstimadoBRL = Number(r.custoGeradoBRL) || 0;

          // Motor v2 (ver Code_HMB.gs): consumo medido/referência/percentual
          // já vêm exatos, persistidos no instante real do alerta — usa
          // direto, sem aproximar. Linhas antigas (HCN, ou HMB antes dessa
          // mudança) não têm esses campos (vêm 0) — cai na reconstrução por
          // telemetria mais próxima, como sempre foi.
          const consumoMedidoPersistido = Number(r.consumoMedido) || 0;
          const consumoReferenciaPersistido = Number(r.consumoReferencia) || 0;
          const percentualPersistido = Number(r.percentualExcedente) || 0;
          const temDadoPersistido = consumoMedidoPersistido > 0 && consumoReferenciaPersistido > 0;

          if (temDadoPersistido) {
            val = consumoMedidoPersistido;
            expectedMax = consumoReferenciaPersistido * (1 + marginPct / 100);
            if (val > expectedMax) {
              projecaoMensalBRL = calcFinancialImpact(val, consumoReferenciaPersistido, r.band).projecaoMensalBRL;
            }
          } else if (closestPoint) {
            val = Number(closestPoint[r.sectorKey]) || 0;
            const stat = sStats[r.sectorKey]?.[r.band];
            if (stat) {
               expectedMax = stat.mean * (1 + marginPct / 100);
               if (val > expectedMax) {
                 projecaoMensalBRL = calcFinancialImpact(val, expectedMax, r.band).projecaoMensalBRL;
               }
            }
          }

          return {
            sectorKey: r.sectorKey,
            sectorName,
            band: r.band,
            time: closestPoint?.time || '00:00',
            date: closestPoint?.date || r.loggedAt,
            val,
            mean: 0,
            std: 0,
            deviation: temDadoPersistido ? percentualPersistido : 0,
            expectedMax,
            centralValue: temDadoPersistido ? consumoReferenciaPersistido : 0,
            representativeMetric: 'mean',
            crossValidated: false,
            severity: 'Crítico',
            frequenciaHistorica: 0,
            templateOverride: undefined,
            excedenteKwh,
            custoEstimadoBRL,
            projecaoMensalBRL,
            loggedAt: r.loggedAt,
            hospitalId: hospital.id,
          } as unknown as LoggedAlert;
        });

        if (!cancelled) setRemoteLogs(reconstructed);
      })
      .catch(err => console.warn("Aviso (Sincronização): Não foi possível carregar o histórico remoto:", err))
      .finally(() => { if (!cancelled) setLoadingRemote(false); });
    return () => { cancelled = true; };
  }, [data, remoteHistoryAvailable, hospital.id]);

  const allLogs = useMemo(() => {
    // Merge local and remote, deduplicating by sectorKey and timestamp (within 1 hour)
    // Logs locais antigos não tinham hospitalId e pertencem ao hospital padrão.
    const merged = [...localLogs.filter(log => {
      if (log.hospitalId) return log.hospitalId === hospital.id;
      // Migra logicamente registros antigos sem hospitalId pelo identificador
      // do setor, que é distinto entre HCN e HMB. Setores desconhecidos não
      // são atribuídos a nenhum hospital para evitar mistura de dados.
      const normalizedSectorKey = log.sectorKey.replace(/^\./, '');
      const owner = HOSPITALS.find(candidate => candidate.allSectors.some(key => key.replace(/^\./, '') === normalizedSectorKey));
      return owner?.id === hospital.id;
    }), ...manualLogs];
    
    for (const remote of remoteLogs) {
      const rTime = new Date(remote.loggedAt).getTime();
      const isDup = merged.some(m => {
        if (m.hospitalId && m.hospitalId !== hospital.id) return false;
        if (m.sectorKey !== remote.sectorKey) return false;
        const mTime = new Date(m.loggedAt).getTime();
        return Math.abs(mTime - rTime) < 60 * 60 * 1000; // 1 hour threshold for duplicates
      });
      if (!isDup) {
        merged.push(remote);
      }
    }
    return merged.map(log => edits[alertId(log)] || log);
  }, [localLogs, remoteLogs, manualLogs, edits, hospital.id]);

  const filteredLogs = useMemo(() => {
    let cutoffDate = new Date(0);
    let endDate = new Date('9999-12-31');

    if (daysFilter === 'custom') {
      if (customStartDate) {
        cutoffDate = new Date(customStartDate);
        // Force the cutoff to the start of the day in local time
        cutoffDate = new Date(cutoffDate.getTime() + cutoffDate.getTimezoneOffset() * 60000);
        cutoffDate.setHours(0, 0, 0, 0);
      }
      if (customEndDate) {
        endDate = new Date(customEndDate);
        endDate = new Date(endDate.getTime() + endDate.getTimezoneOffset() * 60000);
        endDate.setHours(23, 59, 59, 999);
      }
    } else {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysFilter);
    }

    return allLogs.filter(log => {
      if (sectorFilter !== 'ALL' && log.sectorName !== sectorFilter) return false;
      const logDate = new Date(log.loggedAt);
      if (logDate < cutoffDate || logDate > endDate) return false;
      return true;
    }).sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());
  }, [allLogs, sectorFilter, daysFilter, customStartDate, customEndDate]);

  // Range customizado com data final antes da inicial não tem resultado
  // possível — sinaliza isso explicitamente em vez de cair na mensagem
  // genérica de "nenhum dado", que confundiria causa (filtro inválido) com
  // efeito (sem dados no período).
  const dateRangeError = useMemo(() => {
    if (daysFilter !== 'custom' || !customStartDate || !customEndDate) return null;
    return customEndDate < customStartDate ? 'A data final não pode ser anterior à data inicial.' : null;
  }, [daysFilter, customStartDate, customEndDate]);

  const uniqueSectors = useMemo(() => {
    return Array.from(new Set(allLogs.map(l => l.sectorName))).sort();
  }, [allLogs]);

  const totalCost = useMemo(() => {
    return filteredLogs.reduce((acc, log) => acc + log.custoEstimadoBRL, 0);
  }, [filteredLogs]);

  const totalExcedente = useMemo(() => {
    return filteredLogs.reduce((acc, log) => acc + log.excedenteKwh, 0);
  }, [filteredLogs]);

  const summaryBySector = useMemo(() => {
    const summary: Record<string, { count: number; excedente: number; custo: number }> = {};
    filteredLogs.forEach(log => {
      if (!summary[log.sectorName]) {
        summary[log.sectorName] = { count: 0, excedente: 0, custo: 0 };
      }
      summary[log.sectorName].count += 1;
      summary[log.sectorName].excedente += log.excedenteKwh;
      summary[log.sectorName].custo += log.custoEstimadoBRL;
    });

    return Object.entries(summary).map(([sector, data]) => ({
      sector,
      ...data
    }))
    .sort((a, b) => b.custo - a.custo);
  }, [filteredLogs]);

  const handleExportXLSX = () => {
    // Sheet 1: Summary
    const exportSummary = summaryBySector.map(s => ({
      'Setor': s.sector,
      'Quantidade de Alertas': s.count,
      'Total de kWh (Excedente)': s.excedente,
      'Total de Custo (R$)': s.custo
    }));
    exportSummary.push({
      'Setor': 'TOTAL GERAL',
      'Quantidade de Alertas': filteredLogs.length,
      'Total de kWh (Excedente)': totalExcedente,
      'Total de Custo (R$)': totalCost
    });

    // Sheet 2: Details
    const exportData = filteredLogs.map(log => ({
      'Data/Hora Envio': new Date(log.loggedAt).toLocaleString('pt-BR'),
      'Data/Hora Anomalia': `${log.date} ${log.time}`,
      'Setor': log.sectorName,
      'Severidade': log.severity,
      'Consumo Registrado (kWh)': log.val,
      'Padrão Esperado (kWh)': log.expectedMax,
      'Excedente (kWh)': log.excedenteKwh,
      'Custo do Evento (R$)': log.custoEstimadoBRL,
      'Projeção Mensal (R$)': log.projecaoMensalBRL
    }));

    const workbook = XLSX.utils.book_new();
    const wsSummary = XLSX.utils.json_to_sheet(exportSummary);
    const wsDetails = XLSX.utils.json_to_sheet(exportData);
    
    XLSX.utils.book_append_sheet(workbook, wsSummary, "Resumo por Setor");
    XLSX.utils.book_append_sheet(workbook, wsDetails, "Detalhes dos Alertas");
    XLSX.writeFile(workbook, `historico_alertas_${hospital.id}.xlsx`);
  };

  const openEditor = (log?: LoggedAlert) => {
    setEditing(log ? { id: alertId(log), log } : {});
    setForm({
      sectorName: log?.sectorName || '', loggedAt: (log?.loggedAt || new Date().toISOString()).slice(0, 16),
      date: log?.date || new Date().toISOString().slice(0, 10), time: log?.time || new Date().toTimeString().slice(0, 5),
      val: String(log?.val ?? ''), expectedMax: String(log?.expectedMax ?? ''), excedenteKwh: String(log?.excedenteKwh ?? ''),
      custoEstimadoBRL: String(log?.custoEstimadoBRL ?? ''), severity: log?.severity || 'Atenção',
    });
  };
  const saveAlert = (event: React.FormEvent) => {
    event.preventDefault();
    const original = editing?.log;
    const sectorKey = original?.sectorKey || hospital.allSectors.find(key => (hospital.sectorMapping[key]?.label || key) === form.sectorName) || form.sectorName;
    const updated = {
      ...(original || { sectorKey, band: 'Demais Horários', mean: 0, std: 0, deviation: 0, centralValue: 0, representativeMetric: 'mean', crossValidated: false, frequenciaHistorica: 0 }),
      sectorKey, sectorName: form.sectorName, loggedAt: new Date(form.loggedAt).toISOString(), date: form.date, time: form.time,
      val: Number(form.val) || 0, expectedMax: Number(form.expectedMax) || 0, excedenteKwh: Number(form.excedenteKwh) || 0,
      custoEstimadoBRL: Number(form.custoEstimadoBRL) || 0, projecaoMensalBRL: original?.projecaoMensalBRL || 0,
      severity: form.severity, hospitalId: hospital.id,
      id: editing?.id || `manual-${crypto.randomUUID()}`,
    } as unknown as LoggedAlert;
    if (editing?.id) {
      const next = { ...edits, [editing.id]: updated };
      setEdits(next); localStorage.setItem(`alert_edits_${hospital.id}`, JSON.stringify(next));
    } else {
      const next = [updated, ...manualLogs];
      setManualLogs(next); localStorage.setItem(`alert_manual_${hospital.id}`, JSON.stringify(next));
    }
    setEditing(null);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 history-print-area">
      <style>{`@media print { body * { visibility: hidden !important; } .history-print-area, .history-print-area * { visibility: visible !important; } .history-print-area { position: absolute !important; inset: 0 !important; width: 100% !important; background: white !important; color: #111 !important; } .history-print-area .no-print { display: none !important; } .history-print-area .chart-container, .history-print-area table, .history-print-area th, .history-print-area td { background: white !important; color: #111 !important; border-color: #bbb !important; } .history-print-area h2 { color: #111 !important; } }`}</style>
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <AlertCircle className="text-blue-500 w-6 h-6" />
            Histórico de Alertas Enviados
          </h2>
          <p className="text-gray-400 text-sm mt-1">
            Registro de alertas sincronizados do servidor e locais.
          </p>
        </div>
        <div className="flex flex-col md:flex-row gap-2 no-print">
          <div className="flex items-center gap-2 bg-[#1A1A1A] border border-[#333] px-3 py-1.5 rounded-md">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              className="bg-transparent text-sm text-gray-200 outline-none border-none"
              value={sectorFilter}
              onChange={e => setSectorFilter(e.target.value)}
            >
              <option value="ALL">Todos os Setores</option>
              {uniqueSectors.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 bg-[#1A1A1A] border border-[#333] px-3 py-1.5 rounded-md">
            <Search className="w-4 h-4 text-gray-400" />
            <select
              className="bg-transparent text-sm text-gray-200 outline-none border-none"
              value={daysFilter}
              onChange={e => {
                const val = e.target.value;
                setDaysFilter(val === 'custom' ? 'custom' : Number(val));
              }}
            >
              <option value={7}>Últimos 7 dias</option>
              <option value={15}>Últimos 15 dias</option>
              <option value={30}>Últimos 30 dias</option>
              <option value={90}>Últimos 90 dias</option>
              <option value="custom">Período Específico</option>
            </select>
          </div>
          {daysFilter === 'custom' && (
            <div className="flex items-center gap-2 bg-[#1A1A1A] border border-[#333] px-3 py-1.5 rounded-md">
              <input
                type="date"
                className="bg-transparent text-sm text-gray-200 outline-none border-none"
                value={customStartDate}
                onChange={e => setCustomStartDate(e.target.value)}
                title="Data inicial"
              />
              <span className="text-gray-500 text-xs">até</span>
              <input
                type="date"
                className="bg-transparent text-sm text-gray-200 outline-none border-none"
                value={customEndDate}
                onChange={e => setCustomEndDate(e.target.value)}
                title="Data final"
              />
            </div>
          )}
          <button
            onClick={handleExportXLSX}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 rounded-md border border-green-500/30 transition-colors text-sm font-medium"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Exportar XLSX
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 rounded-md border border-blue-500/30 transition-colors text-sm font-medium"><FileText className="w-4 h-4" /> Exportar PDF</button>
          <button onClick={() => openEditor()} className="flex items-center gap-2 px-3 py-1.5 bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 rounded-md border border-violet-500/30 transition-colors text-sm font-medium"><Plus className="w-4 h-4" /> Adicionar alerta</button>
        </div>
      </div>

      {!remoteHistoryAvailable && (
        <div className="chart-container border border-amber-500/30 bg-amber-950/10 flex items-start gap-3">
          <AlertCircle className="text-amber-500 w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <div className="text-amber-400 font-semibold text-sm">Histórico de alertas do {hospital.label} ainda não configurado</div>
            <div className="text-gray-400 text-sm mt-1">
              O backend já atende este hospital, mas falta a planilha de telemetria do {hospital.label} e o Apps Script da planilha de
              estado de alertas. Assim que essa integração existir, esta tela passa a mostrar os alertas dele aqui também.
            </div>
          </div>
        </div>
      )}

      {(<>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">TOTAL DE ALERTAS (FILTRO)</div>
             <div className="flex items-center gap-2">
               <div className="text-2xl font-bold text-white font-mono">{filteredLogs.length}</div>
               {loadingRemote && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
             </div>
           </div>
        </div>
        <div className="chart-container flex items-center justify-between col-span-1">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">EXCEDENTE TOTAL (FILTRO)</div>
             <div className="text-2xl font-bold text-amber-500 font-mono">{totalExcedente.toFixed(1)} <span className="text-sm text-amber-500/70 font-sans">kWh</span></div>
           </div>
        </div>
        <div className="chart-container flex items-center justify-between col-span-1 border border-red-500/20 bg-red-950/10">
           <div>
             <div className="text-gray-400 text-xs font-semibold mb-1">CUSTO TOTAL DESPERDIÇADO (FILTRO)</div>
             <div className="text-2xl font-bold text-red-500 font-mono">{formatBRL(totalCost)}</div>
           </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[#333] pb-2">
        <button
          onClick={() => setViewMode('resumo')}
          className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${viewMode === 'resumo' ? 'bg-[#222] text-white border-t border-l border-r border-[#444]' : 'text-gray-400 hover:text-white'}`}
        >
          Resumo por Setor
        </button>
        <button
          onClick={() => setViewMode('detalhado')}
          className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${viewMode === 'detalhado' ? 'bg-[#222] text-white border-t border-l border-r border-[#444]' : 'text-gray-400 hover:text-white'}`}
        >
          Visão Detalhada
        </button>
      </div>

      <div className="bg-[#1A1A1A] border border-[#333] rounded-md overflow-hidden">
        <div className="overflow-x-auto">
          {viewMode === 'resumo' ? (
            <table className="w-full text-left text-sm text-gray-300">
              <thead className="bg-[#222] text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Setor</th>
                  <th className="px-4 py-3 text-center">Quantidade de Alertas</th>
                  <th className="px-4 py-3 text-right">Total de kWh (Excedente)</th>
                  <th className="px-4 py-3 text-right">Total de Custo (R$)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#333]">
                {dateRangeError ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-red-400">
                      {dateRangeError}
                    </td>
                  </tr>
                ) : loadingRemote && summaryBySector.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Sincronizando alertas do servidor...</span>
                    </td>
                  </tr>
                ) : summaryBySector.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                      Nenhum dado para o período.
                    </td>
                  </tr>
                ) : (
                  <>
                    {summaryBySector.map(s => (
                      <tr key={s.sector} className="hover:bg-[#222]/50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-200">{s.sector}</td>
                        <td className="px-4 py-3 text-center font-mono">{s.count}</td>
                        <td className="px-4 py-3 text-right font-mono text-amber-400">{s.excedente.toFixed(2)} kWh</td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">{formatBRL(s.custo)}</td>
                      </tr>
                    ))}
                    <tr className="bg-[#2a2a2a] font-bold border-t-2 border-[#444]">
                      <td className="px-4 py-3 text-white">TOTAL GERAL</td>
                      <td className="px-4 py-3 text-center font-mono text-white">{filteredLogs.length}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-500">{totalExcedente.toFixed(2)} kWh</td>
                      <td className="px-4 py-3 text-right font-mono text-red-500">{formatBRL(totalCost)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-sm text-gray-300">
              <thead className="bg-[#222] text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Data/Hora (Envio)</th>
                  <th className="px-4 py-3">Setor</th>
                  <th className="px-4 py-3">Consumo</th>
                  <th className="px-4 py-3">Excedente</th>
                  <th className="px-4 py-3">Custo do Evento</th>
                  <th className="px-4 py-3">Severidade</th>
                  <th className="px-4 py-3 no-print">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#333]">
              {dateRangeError ? (
                <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-red-400">
                    {dateRangeError}
                  </td>
                </tr>
              ) : loadingRemote && filteredLogs.length === 0 ? (
                <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500 flex justify-center items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Sincronizando alertas do servidor...
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    Nenhum alerta enviado encontrado para os filtros selecionados.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log, idx) => (
                  <tr key={idx} className="hover:bg-[#222]/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{new Date(log.loggedAt).toLocaleString('pt-BR')}</td>
                    <td className="px-4 py-3 font-medium text-gray-200">{log.sectorName}</td>
                    <td className="px-4 py-3 font-mono">{log.val.toFixed(1)} kWh</td>
                    <td className="px-4 py-3 font-mono text-amber-400">+{log.excedenteKwh.toFixed(1)} kWh</td>
                    <td className="px-4 py-3 font-mono text-red-400">{formatBRL(log.custoEstimadoBRL)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${log.severity === 'Crítico' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {log.severity.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 no-print"><button onClick={() => openEditor(log)} title="Editar alerta" className="text-blue-300 hover:text-white"><Pencil className="w-4 h-4" /></button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>
      </>)}

      {editing !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 no-print">
          <form onSubmit={saveAlert} className="w-full max-w-xl space-y-4 rounded-lg border border-[#444] bg-[#1A1A1A] p-6 shadow-xl">
            <div className="flex items-center justify-between"><h3 className="text-lg font-semibold text-white">{editing.log ? 'Editar alerta' : 'Adicionar alerta manual'}</h3><button type="button" onClick={() => setEditing(null)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs text-gray-400">Setor<select required value={form.sectorName} onChange={e => setForm({ ...form, sectorName: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white"><option value="">Selecione</option>{hospital.allSectors.map(key => <option key={key} value={hospital.sectorMapping[key]?.label || key}>{hospital.sectorMapping[key]?.label || key}</option>)}{form.sectorName && !hospital.allSectors.some(key => (hospital.sectorMapping[key]?.label || key) === form.sectorName) && <option value={form.sectorName}>{form.sectorName}</option>}</select></label>
              <label className="text-xs text-gray-400">Severidade<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white"><option>Atenção</option><option>Crítico</option></select></label>
              <label className="text-xs text-gray-400">Data/hora do envio<input required type="datetime-local" value={form.loggedAt} onChange={e => setForm({ ...form, loggedAt: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-400">Data/hora da anomalia<div className="mt-1 flex gap-2"><input required type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="min-w-0 flex-1 rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /><input required type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="min-w-0 flex-1 rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></div></label>
              <label className="text-xs text-gray-400">Consumo (kWh)<input type="number" step="any" value={form.val} onChange={e => setForm({ ...form, val: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-400">Padrão esperado (kWh)<input type="number" step="any" value={form.expectedMax} onChange={e => setForm({ ...form, expectedMax: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-400">Excedente (kWh)<input type="number" step="any" value={form.excedenteKwh} onChange={e => setForm({ ...form, excedenteKwh: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-400">Custo (R$)<input type="number" step="any" value={form.custoEstimadoBRL} onChange={e => setForm({ ...form, custoEstimadoBRL: e.target.value })} className="mt-1 w-full rounded border border-[#444] bg-[#222] p-2 text-sm text-white" /></label>
            </div>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setEditing(null)} className="rounded px-4 py-2 text-sm text-gray-300 hover:bg-[#333]">Cancelar</button><button type="submit" className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"><Save className="h-4 w-4" /> Salvar</button></div>
          </form>
        </div>
      )}

    </div>
  );
}
