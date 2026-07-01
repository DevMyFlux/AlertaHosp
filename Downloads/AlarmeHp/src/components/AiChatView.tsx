import React, { useState, useEffect } from 'react';
import { Bot, Send, User, Trash2 } from 'lucide-react';
import { ProcessedTelemetryData, ALL_SECTORS } from '../types';
import Markdown from 'react-markdown';

interface Props {
  data: ProcessedTelemetryData[];
}

export function AiChatView({ data }: Props) {
  const defaultMessage = { role: 'ai' as const, text: 'Olá! Sou seu Assistente Especialista em Eficiência Energética Hospitalar. Monitoro todos os disjuntores da planta em janelas de 15 minutos. Estou pronto para cruzar dados de setpoints principais com submedições de clima e qualidade de energia. O que deseja analisar hoje?' };
  
  const [messages, setMessages] = useState<{role: 'user' | 'ai', text: string}[]>(() => {
    const saved = localStorage.getItem('ai_chat_messages');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // Fallback
      }
    }
    return [defaultMessage];
  });
  const [input, setInput] = useState('');

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem('ai_chat_messages', JSON.stringify(messages));
  }, [messages]);

  const handleClearChat = () => {
    setMessages([defaultMessage]);
    localStorage.removeItem('ai_chat_messages');
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    
    const currentInput = input;
    setMessages(prev => [...prev, { role: 'user', text: currentInput }]);
    setInput('');
    setIsLoading(true);

    try {
      // Create a short summary of data for the AI context (e.g. latest 50 records)
      const recentData = data.slice(-50); // Take last 50 records as context
      const telemetrySummary = data && data.length > 0 ? JSON.stringify(recentData) : "[]";

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: currentInput,
          telemetryData: telemetrySummary
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || 'Falha na comunicação com o servidor');
      }

      const result = await response.json();
      setMessages(prev => [...prev, { role: 'ai', text: result.text }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'ai', text: 'Ocorreu um erro ao processar sua solicitação. Por favor, tente novamente.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] bg-[#0a0a0c] border border-[#333] rounded-lg overflow-hidden animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#222] bg-[#111]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/10 border border-purple-500/30 rounded-lg">
            <Bot className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-200">MyFlux AI Chat</h2>
            <p className="text-xs text-gray-400">Interaja com a inteligência artificial para diagnósticos personalizados</p>
          </div>
        </div>
        <button
          onClick={handleClearChat}
          className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors border border-transparent hover:border-red-400/20"
          title="Limpar Histórico"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'ai' && (
              <div className="w-8 h-8 rounded-full bg-purple-900/30 flex items-center justify-center flex-shrink-0 border border-purple-500/30">
                <Bot className="w-4 h-4 text-purple-400" />
              </div>
            )}
            
            <div className={`whitespace-pre-wrap max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === 'user' 
                ? 'bg-blue-600 text-white rounded-tr-none' 
                : 'bg-[#18181b] text-gray-300 border border-[#333] rounded-tl-none'
            }`}>
              {msg.role === 'ai' ? (
                <div className="markdown-body">
                  <Markdown>{msg.text}</Markdown>
                </div>
              ) : (
                msg.text
              )}
            </div>

            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-[#222] flex items-center justify-center flex-shrink-0 border border-[#333]">
                <User className="w-4 h-4 text-gray-400" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-[#222] bg-[#111]">
        <div className="relative flex items-center">
          <input 
            type="text" 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Digite seu prompt ou dúvida para a IA..."
            className="w-full bg-[#18181b] border border-[#333] rounded-full py-3 pl-4 pr-12 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
          />
          <button 
            onClick={handleSend}
            disabled={!input.trim()}
            className="absolute right-2 p-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-full transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
