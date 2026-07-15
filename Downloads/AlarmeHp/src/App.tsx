import React, { useState, useEffect, useRef } from 'react';
import { generateMockData } from './data/mockData';
import { processCumulativeData } from './data/processor';
import { ProcessedTelemetryData } from './types';
import { buildSectorBandStats, detectSectorAnomalies, formatSectorParam, formatValorParam, formatSetorNomeParam, formatDataHoraParam, formatPercentualParam, formatExcedenteKwhParam, formatCustoEventoParam, formatImpactoMensalValorParam, formatOcorrenciasParam, formatCausaProvavelParam, formatAcaoRecomendadaParam, formatStandardAlertMessage } from './lib/anomalyDetection';
import { logAlert } from './lib/alertLog';
import { ExecutiveView } from './components/ExecutiveView';
import { HVACView } from './components/HVACView';
import { ImagingView } from './components/ImagingView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { SectorView } from './components/SectorView';
// AI Chat temporariamente removida do menu: GEMINI_API_KEY ainda não
// confirmada na Vercel (não afeta o envio de alertas). Componente e rota
// /api/chat continuam no código, só tiramos da navegação.
// import { AiChatView } from './components/AiChatView';
import { LiveMonitorView } from './components/LiveMonitorView';
import { SettingsView } from './components/SettingsView';
import Papa from 'papaparse';
import { Activity, Wind, Radio, Database, UploadCloud, Bot, BarChart2, Clock, Settings } from 'lucide-react';
import clsx from 'clsx';

export default function App() {
  const [activeTab, setActiveTab] = useState<'executive' | 'hvac' | 'imaging' | 'diagnostics' | 'sector' | 'live' | 'settings'>('executive');
  const [data, setData] = useState<ProcessedTelemetryData[]>([]);
  const [isSimulated, setIsSimulated] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(
    localStorage.getItem('auto_check_enabled') !== 'false'
  );

  const SHEET_URL = "https://docs.google.com/spreadsheets/d/15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs/export?format=csv&gid=681869284";

  // Setores que já dispararam alerta e ainda não voltaram ao normal — evita
  // reenviar WhatsApp a cada ciclo de 15 min enquanto a mesma anomalia
  // persiste (spam pro destinatário e risco de limite/qualidade na Meta).
  const alertedSectorsRef = useRef<Set<string>>(new Set());

  const checkAnomaliesAndAlert = async (processedData: ProcessedTelemetryData[]) => {
    if (processedData.length === 0) return;

    const last = processedData[processedData.length - 1];
    const sStats = buildSectorBandStats(processedData);
    const anomalies = detectSectorAnomalies(last, sStats, processedData);

    const currentSectorKeys = new Set(anomalies.map(a => a.sectorKey));
    // Setores que normalizaram podem alertar de novo na próxima vez que
    // ficarem anômalos.
    for (const key of Array.from(alertedSectorsRef.current)) {
      if (!currentSectorKeys.has(key)) {
        alertedSectorsRef.current.delete(key);
      }
    }

    const phone = localStorage.getItem('notify_phone_number') || '5511949102183';
    const appId = localStorage.getItem('vonage_app_id') || '';
    const privateKey = localStorage.getItem('vonage_private_key') || '';
    const whatsappFrom = localStorage.getItem('vonage_whatsapp_from') || '556298792013';

    for (const anomaly of anomalies) {
      if (alertedSectorsRef.current.has(anomaly.sectorKey)) continue;
      alertedSectorsRef.current.add(anomaly.sectorKey);
      logAlert(anomaly);

      console.log(`Anomalia detectada em ${anomaly.sectorName}! Enviando alerta automático...`);

      const message = formatStandardAlertMessage(anomaly);
      const sectorParam = formatSectorParam(anomaly.sectorName, anomaly.severity);
      const valor = formatValorParam(anomaly.val, anomaly.expectedMax);
      const templateParams = anomaly.templateOverride
        ? [
            formatDataHoraParam(anomaly),
            formatSetorNomeParam(anomaly.sectorName),
            formatPercentualParam(anomaly),
            formatExcedenteKwhParam(anomaly),
            formatCustoEventoParam(anomaly),
            formatImpactoMensalValorParam(anomaly),
            formatOcorrenciasParam(anomaly),
            formatCausaProvavelParam(anomaly),
            formatAcaoRecomendadaParam(anomaly),
          ]
        : undefined;

      try {
        const notifyResponse = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sector: sectorParam, message, valor, phone, appId, privateKey, whatsappFrom,
            templateOverride: anomaly.templateOverride, templateParams
          })
        });
        const notifyData = await notifyResponse.json();
        const smsFallback = (notifyData.results || []).find((r: any) => r.channel === 'sms' && r.whatsappError);
        if (smsFallback) {
          console.warn("WhatsApp falhou, notificação caiu para SMS:", smsFallback.whatsappError);
        }
      } catch (error) {
        console.error(`Erro ao notificar automaticamente sobre ${anomaly.sectorName}:`, error);
        // Falhou o envio: libera pra tentar de novo no próximo ciclo.
        alertedSectorsRef.current.delete(anomaly.sectorKey);
      }
    }
  };

  const fetchData = () => {
    fetch(SHEET_URL)
      .then(response => {
        if (!response.ok) throw new Error("Network response was not ok");
        return response.text();
      })
      .then(csvText => {
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            try {
              if (results.data && results.data.length > 0) {
                const raw = results.data as any[];
                const processed = processCumulativeData(raw);
                setData(processed);
                setIsSimulated(false);
                setLastUpdate(new Date());
                checkAnomaliesAndAlert(processed);
              } else {
                throw new Error("No data found");
              }
            } catch (error) {
              console.warn("Parse error:", error);
              const mock = generateMockData();
              const processedMock = processCumulativeData(mock);
              setData(processedMock);
              setIsSimulated(true);
              setLastUpdate(new Date());
              checkAnomaliesAndAlert(processedMock);
            }
          }
        });
      })
      .catch(err => {
        console.warn("Fetch error:", err);
        const mock = generateMockData();
        const processedMock = processCumulativeData(mock);
        setData(processedMock);
        setIsSimulated(true);
        setLastUpdate(new Date());
        checkAnomaliesAndAlert(processedMock);
      });
  };

  // Load Sim Data on mount and refresh every 15 minutes (900000 ms) if enabled
  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    localStorage.setItem('auto_check_enabled', String(autoCheckEnabled));
    let interval: NodeJS.Timeout | undefined;
    if (autoCheckEnabled) {
      interval = setInterval(fetchData, 900000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoCheckEnabled]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const raw = results.data as any[];
          const processed = processCumulativeData(raw);
          setData(processed);
          setIsSimulated(false);
        } catch (error) {
          console.warn("Parse error:", error);
          alert("Erro ao processar arquivo. Verifique se o formato atende à arquitetura esperada.");
        }
      }
    });
  };

  return (
    <div className="dashboard-grid">
      
      {/* Header */}
      <header className="header-bar">
        <div>
          <span style={{ fontWeight: 900, letterSpacing: '2px', color: 'var(--accent-blue)' }}>MyFlux</span>
          <span style={{ marginLeft: '15px', fontSize: '12px', opacity: 0.6 }}>TELEMETRIA ENERGÉTICA</span>
        </div>
        <div style={{ display: 'flex', gap: '20px', fontSize: '11px', alignItems: 'center' }}>
            <button 
              onClick={() => setAutoCheckEnabled(!autoCheckEnabled)} 
              className={clsx("px-2 py-1 border rounded text-[10px] flex items-center gap-1 transition-colors cursor-pointer", autoCheckEnabled ? "border-[var(--accent-green)] text-[var(--accent-green)]" : "border-gray-500 text-gray-500")}
              title="Ativar/Desativar verificação automática de 15 em 15 minutos"
            >
              <Clock className="w-3 h-3" />
              AUTO-CHECK: {autoCheckEnabled ? "ON (15m)" : "OFF"}
            </button>
            <div className="flex items-center">
              <Database className="w-3 h-3 mr-1 text-gray-400" />
              FONTE: <span className="ml-1" style={{ color: isSimulated ? 'var(--accent-amber)' : 'var(--accent-green)' }}>{isSimulated ? 'MOCK' : 'CSV'}</span>
            </div>
            <div>STATUS: <span className="status-dot status-good"></span>OPERACIONAL</div>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="sidebar">
        
        <div className="filter-group">
          <label>Visões</label>
          <div className="space-y-2">
            <TabButton active={activeTab === 'executive'} onClick={() => setActiveTab('executive')} icon={<Activity className="w-4 h-4" />}>Visão Executiva</TabButton>
            <TabButton active={activeTab === 'live'} onClick={() => setActiveTab('live')} icon={<Clock className="w-4 h-4" />}>Monitoramento 15m</TabButton>
            <TabButton active={activeTab === 'sector'} onClick={() => setActiveTab('sector')} icon={<BarChart2 className="w-4 h-4" />}>Análise Setorial (15m)</TabButton>
            <TabButton active={activeTab === 'hvac'} onClick={() => setActiveTab('hvac')} icon={<Wind className="w-4 h-4" />}>Operação e HVAC</TabButton>
            <TabButton active={activeTab === 'imaging'} onClick={() => setActiveTab('imaging')} icon={<Radio className="w-4 h-4" />}>Diag. Imagem</TabButton>
            <TabButton active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} icon={<Bot className="w-4 h-4" />}>AI Diagnostics</TabButton>
            <TabButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings className="w-4 h-4" />}>Configurações</TabButton>
          </div>
        </div>

        <div className="filter-group mt-4">
          <label>Controle de Dados</label>
          <label className="btn-tab text-center justify-center">
            <UploadCloud className="w-4 h-4" />
            Carregar CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>

        <div className="math-hint">
          Cálculo: Δ kWh = P(t) - P(t-1) <br/>
          Filtro: Quality == 192
        </div>
        <div style={{ marginTop: 'auto', fontSize: '10px', opacity: 0.4 }}>
          Senior BI Engineer System<br/>Utilities Monitoring
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
          {activeTab === 'executive' && <ExecutiveView data={data} />}
          {activeTab === 'live' && <LiveMonitorView data={data} lastUpdate={lastUpdate} onRefresh={fetchData} />}
          {activeTab === 'sector' && <SectorView data={data} />}
          {activeTab === 'hvac' && <HVACView data={data} />}
          {activeTab === 'imaging' && <ImagingView data={data} />}
          {activeTab === 'diagnostics' && <DiagnosticsView data={data} />}
          {activeTab === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean, onClick: () => void, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx("btn-tab", active && "active")}
    >
      <span className={clsx("transition-colors", active ? "text-[var(--accent-blue)]" : "text-gray-500")}>
        {icon}
      </span>
      {children}
    </button>
  );
}
