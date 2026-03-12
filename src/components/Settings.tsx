import React, { useState, useEffect } from 'react';
import { Save, Loader2, Key, Globe, Cpu, Database, Info, AlertCircle } from 'lucide-react';
import { apiFetch } from '../api';

export function Settings() {
  const [apiUrl, setApiUrl] = useState('https://api.siliconflow.cn/v1');
  const [apiKey, setApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  
  const [models, setModels] = useState<any[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    // Load initial settings
    apiFetch('/api/settings').then(data => {
      if (data.api_url) setApiUrl(data.api_url);
      if (data.api_key && data.api_key !== '********') setApiKey(data.api_key);
      if (data.llm_model) setLlmModel(data.llm_model);
      if (data.embedding_model) setEmbeddingModel(data.embedding_model);
    }).catch(err => {
      console.error('Failed to load settings', err);
    });
  }, []);

  const fetchModels = async () => {
    if (!apiUrl || !apiKey) {
      setMessage({ type: 'error', text: '请先填写 API URL 和 API Key' });
      return;
    }
    
    setIsLoadingModels(true);
    setMessage(null);
    try {
      const data = await apiFetch('/api/models', {
        method: 'POST',
        body: JSON.stringify({ api_url: apiUrl, api_key: apiKey })
      });
      if (data.data && Array.isArray(data.data)) {
        setModels(data.data);
        setMessage({ type: 'success', text: `成功获取 ${data.data.length} 个模型` });
      } else {
        setMessage({ type: 'error', text: '获取模型列表失败，请检查配置' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '获取模型失败' });
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          api_url: apiUrl,
          api_key: apiKey,
          llm_model: llmModel,
          embedding_model: embeddingModel
        })
      });
      setMessage({ type: 'success', text: '设置保存成功！' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '保存失败' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full bg-white flex flex-col overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-slate-800">AI 模型配置</h2>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          保存配置
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-8">
          
          {message && (
            <div className={`p-4 rounded-xl border ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
              {message.text}
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3 text-blue-800">
            <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm space-y-1">
              <p className="font-semibold">推荐配置 (硅基流动 SiliconFlow)</p>
              <p>LLM 模型推荐使用：<code className="bg-blue-100 px-1 rounded">deepseek-ai/DeepSeek-V3</code> 或 <code className="bg-blue-100 px-1 rounded">Qwen/Qwen2.5-72B-Instruct</code></p>
              <p>向量模型推荐使用：<code className="bg-blue-100 px-1 rounded">BAAI/bge-m3</code> 或 <code className="bg-blue-100 px-1 rounded">BAAI/bge-large-zh-v1.5</code></p>
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-lg font-medium text-slate-900 border-b pb-2">基础连接设置</h3>
            
            <div className="grid gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">API URL (Base URL)</label>
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="text"
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="https://api.siliconflow.cn/v1"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="sk-..."
                  />
                </div>
              </div>

              <div>
                <button
                  onClick={fetchModels}
                  disabled={isLoadingModels || !apiUrl || !apiKey}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors"
                >
                  {isLoadingModels ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                  验证连接并获取模型列表
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-lg font-medium text-slate-900 border-b pb-2">模型选择</h3>
            
            <div className="grid gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">LLM 对话模型</label>
                {models.length > 0 ? (
                  <select
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">请选择模型...</option>
                    {models.map(m => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="例如: deepseek-ai/DeepSeek-V3"
                  />
                )}
                <p className="text-xs text-slate-500 mt-1">用于处理用户提问和生成回答的大语言模型。</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Embedding 向量模型</label>
                {models.length > 0 ? (
                  <select
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">请选择模型...</option>
                    {models.map(m => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="例如: BAAI/bge-m3"
                  />
                )}
                <p className="text-xs text-slate-500 mt-1">用于将知识库文本转换为向量，以便进行相似度检索。</p>
                <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2 text-amber-800">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <p className="font-semibold">⚠️ 提示：请勿随意更换 Embedding 模型</p>
                    <p className="mt-0.5">更换模型将导致整个知识库的本地缓存失效，并在下次检索时重新进行全量向量化，这会消耗较多 API 额度和时间。</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
