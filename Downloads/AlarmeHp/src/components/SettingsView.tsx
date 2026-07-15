import React, { useState, useEffect } from 'react';
import { Settings, Save, Phone, Key, FileText, Plus, X, FlaskConical, Percent, DollarSign } from 'lucide-react';

export function SettingsView() {
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>(['5511949102183']);
  const [newPhoneInput, setNewPhoneInput] = useState('');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [whatsappFrom, setWhatsappFrom] = useState('556298792013');
  const [marginPct, setMarginPct] = useState('20');
  const [tariff, setTariff] = useState('0,75');
  const [testingType, setTestingType] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('notify_phone_number');
    if (saved) {
      const list = saved.split(',').map(p => p.trim()).filter(Boolean);
      if (list.length) setPhoneNumbers(list);
    }

    const savedAppId = localStorage.getItem('vonage_app_id');
    if (savedAppId) setAppId(savedAppId);

    const savedKey = localStorage.getItem('vonage_private_key');
    if (savedKey) setPrivateKey(savedKey);

    const savedFrom = localStorage.getItem('vonage_whatsapp_from');
    if (savedFrom) setWhatsappFrom(savedFrom);

    const savedMargin = localStorage.getItem('alert_margin_pct');
    if (savedMargin) setMarginPct(savedMargin);

    const savedTariff = localStorage.getItem('tariff_brl_per_kwh');
    if (savedTariff) setTariff(savedTariff);
  }, []);

  const handleAddPhone = () => {
    const cleaned = newPhoneInput.replace(/\D/g, '');
    if (!cleaned || phoneNumbers.includes(cleaned)) {
      setNewPhoneInput('');
      return;
    }
    setPhoneNumbers(prev => [...prev, cleaned]);
    setNewPhoneInput('');
  };

  const handleRemovePhone = (num: string) => {
    setPhoneNumbers(prev => prev.filter(p => p !== num));
  };

  const handleSave = () => {
    localStorage.setItem('notify_phone_number', phoneNumbers.join(','));
    localStorage.setItem('vonage_app_id', appId);
    localStorage.setItem('vonage_private_key', privateKey);
    localStorage.setItem('vonage_whatsapp_from', whatsappFrom);

    const marginNum = Number(String(marginPct).replace(',', '.'));
    if (!isNaN(marginNum) && marginNum > 0) {
      localStorage.setItem('alert_margin_pct', String(marginNum));
    }

    const tariffNum = Number(String(tariff).replace(',', '.'));
    if (!isNaN(tariffNum) && tariffNum > 0) {
      localStorage.setItem('tariff_brl_per_kwh', String(tariffNum));
    }

    alert('Configurações salvas com sucesso!');
  };

  // Diagnóstico temporário: dispara um envio real de teste direto pra cada
  // um dos 4 templates por tipo (valores fictícios, claramente marcados
  // como TESTE) e mostra a resposta completa da Vonage na tela — inclui
  // status de aceite síncrono; a rejeição real (se houver) só aparece no
  // webhook /api/webhooks/vonage-status, ver Logs da Vercel. Remover este
  // bloco depois que os 4 templates estiverem confirmados entregando.
  // templateParams segue o formato novo de 4 variáveis (data/hora, setor,
  // quanto passou do padrão esperado, custo estimado) — ver
  // src/lib/anomalyDetection.ts (formatDataHoraParam e cia) e os corpos de
  // template combinados com o cliente.
  const TEST_TEMPLATES: Record<string, { template: string; params: [string, string, string, string] }> = {
    'Crítico': { template: 'alerta_critico_energia_v2', params: ['segunda-feira, 14/07 às 05:38', 'UTI QG (TESTE)', '30% acima do padrão (22,4 kWh no intervalo)', 'R$ 1.240,00/mês (se persistir 8h/dia)'] },
    'Imagem': { template: 'alerta_imagem_energia_v2', params: ['terça-feira, 14/07 às 14:10', 'TOMOGRAFIA (TESTE)', '45% acima do padrão (95,3 kWh no intervalo)', 'R$ 3.100,00/mês (se persistir 6h/dia)'] },
    'HVAC': { template: 'alerta_hvac_energia_v2', params: ['quarta-feira, 14/07 às 11:00', 'HVAC LAVANDERIA (TESTE)', '25% acima do padrão (3,8 kWh no intervalo)', 'R$ 210,00/mês (se persistir 4h/dia)'] },
    'Infra': { template: 'alerta_infra_energia_v2', params: ['quinta-feira, 14/07 às 19:20', 'LAVANDERIA (TESTE)', '35% acima do padrão (16,2 kWh no intervalo)', 'R$ 620,00/mês (se persistir 4h/dia)'] },
  };

  const handleTestTemplate = async (type: string) => {
    const cfg = TEST_TEMPLATES[type];
    setTestingType(type);
    setTestResult(null);
    try {
      const phone = phoneNumbers.join(',') || localStorage.getItem('notify_phone_number') || '5511949102183';
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sector: cfg.params[1],
          message: `Mensagem de teste de diagnóstico do template ${type} — pode ignorar.`,
          valor: cfg.params[2],
          phone,
          appId,
          privateKey,
          whatsappFrom,
          templateOverride: cfg.template,
          templateParams: cfg.params,
        }),
      });
      const data = await response.json();
      setTestResult(JSON.stringify({ tipo: type, template: cfg.template, ...data }, null, 2));
    } catch (e: any) {
      setTestResult(`Erro de rede ao chamar /api/notify: ${e?.message || e}`);
    } finally {
      setTestingType(null);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          <Settings className="text-blue-500 w-6 h-6" />
          Configurações do Sistema
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="chart-container">
          <h3 className="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
            <Phone className="w-5 h-5 text-gray-400" />
            Notificações (Destinatário)
          </h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Números de Destino (com DDI e DDD)
              </label>

              <div className="space-y-2 mb-3">
                {phoneNumbers.map((num) => (
                  <div key={num} className="flex items-center justify-between bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2">
                    <span className="text-white font-mono text-sm">{num}</span>
                    <button
                      onClick={() => handleRemovePhone(num)}
                      className="text-gray-500 hover:text-red-400 transition-colors"
                      title="Remover destinatário"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {phoneNumbers.length === 0 && (
                  <p className="text-xs text-amber-500">Nenhum destinatário cadastrado — os alertas não terão para onde ir.</p>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPhoneInput}
                  onChange={(e) => setNewPhoneInput(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddPhone(); } }}
                  placeholder="Ex: 5511949102183"
                  className="flex-1 bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleAddPhone}
                  className="flex items-center gap-1 px-3 py-2 bg-[#1A1A1A] border border-[#333] hover:border-blue-500 text-gray-300 rounded-md text-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Adicionar
                </button>
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Todos os números acima recebem os alertas gerados pela IA via WhatsApp ou SMS (fallback).
              </p>
            </div>

            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium transition-colors"
            >
              <Save className="w-4 h-4" />
              Salvar Configurações
            </button>
          </div>
        </div>

        <div className="chart-container border-blue-500/20">
          <h3 className="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
            <Key className="w-5 h-5 text-blue-400" />
            Credenciais WhatsApp (Vonage)
          </h3>
          
          <div className="space-y-4">
            <div className="p-3 bg-blue-900/20 border border-blue-800/30 rounded-md text-sm text-blue-200 mb-4">
              A API de Mensagens (WhatsApp) da Vonage exige <strong>Application ID</strong> e <strong>Private Key</strong> para funcionar. Caso não sejam preenchidos, o sistema enviará apenas via SMS.
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Application ID
              </label>
              <input
                type="text"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="Ex: 5eaf2088-e756-4eac-988b-6c66d75e22cd"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                WhatsApp Sender Number (From)
              </label>
              <input
                type="text"
                value={whatsappFrom}
                onChange={(e) => setWhatsappFrom(e.target.value.replace(/\D/g, ''))}
                placeholder="Ex: 556298792013"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">
                Private Key
              </label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                rows={5}
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="chart-container border-green-500/20">
        <h3 className="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
          <Percent className="w-5 h-5 text-green-400" />
          Detecção de Anomalias
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">
              Margem de alerta (%)
            </label>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                value={marginPct}
                onChange={(e) => setMarginPct(e.target.value.replace(/[^0-9,.]/g, ''))}
                placeholder="Ex: 20"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md px-4 py-2 pr-9 text-white font-mono text-sm focus:outline-none focus:border-green-500"
              />
              <Percent className="w-4 h-4 text-gray-500 absolute right-3 top-1/2 -translate-y-1/2" />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Um alerta é disparado quando o consumo passa o padrão esperado do setor em mais que essa
              porcentagem. Ex: com 20%, um setor que normalmente consome 100 kWh só vira alerta acima de 120 kWh.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">
              Tarifa de energia (R$/kWh)
            </label>
            <div className="relative">
              <DollarSign className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                inputMode="decimal"
                value={tariff}
                onChange={(e) => setTariff(e.target.value.replace(/[^0-9,.]/g, ''))}
                placeholder="Ex: 0,75"
                className="w-full bg-[#1A1A1A] border border-[#333] rounded-md pl-9 pr-4 py-2 text-white font-mono text-sm focus:outline-none focus:border-green-500"
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Usada pra calcular o custo estimado e a projeção mensal nas mensagens de alerta. O preço do kWh
              varia bastante por estado/distribuidora no Brasil — o valor padrão (R$0,75) é só uma estimativa;
              troque pela tarifa real do contrato do hospital assim que tiver em mãos.
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md font-medium transition-colors text-sm"
        >
          <Save className="w-4 h-4" />
          Salvar Configurações
        </button>
      </div>

      {/* Diagnóstico temporário — remover quando os 4 templates novos
          estiverem confirmados entregando. */}
      <div className="chart-container border-amber-500/30 bg-amber-950/10">
        <h3 className="text-lg font-medium text-gray-200 mb-2 flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-amber-400" />
          Diagnóstico (temporário): templates por tipo
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          Dispara um envio de teste real (valores fictícios, marcados como TESTE) direto pro template do
          tipo escolhido (<code className="text-amber-300">alerta_critico_energia_v2</code>,{' '}
          <code className="text-amber-300">alerta_imagem_energia_v2</code>,{' '}
          <code className="text-amber-300">alerta_hvac_energia_v2</code> ou{' '}
          <code className="text-amber-300">alerta_infra_energia_v2</code>) pros números cadastrados acima, e
          mostra a resposta completa da API. Esse bloco é só pra investigação e será removido depois.
        </p>
        <div className="flex flex-wrap gap-2">
          {Object.keys(TEST_TEMPLATES).map((type) => (
            <button
              key={type}
              onClick={() => handleTestTemplate(type)}
              disabled={testingType !== null}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 rounded-md border border-amber-500/30 font-medium transition-colors text-sm disabled:opacity-50"
            >
              <FlaskConical className="w-4 h-4" />
              {testingType === type ? 'Enviando...' : `Testar ${type}`}
            </button>
          ))}
        </div>
        {testResult && (
          <pre className="mt-4 p-3 bg-[#0a0a0c] border border-[#333] rounded-md text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">
            {testResult}
          </pre>
        )}
      </div>
    </div>
  );
}
