import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Upload, Check, X, FileText, Loader2, AlertCircle, Edit3, Folder, ChevronDown, Save, Eye, Code, File, Plus, Database } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';
import OpenAI from 'openai';
import { diffLines } from 'diff';
import { DocFolder, DocFile } from '../App';
import { apiFetch, getToken } from '../api';

interface AdminPanelProps {
  knowledgeBase: DocFolder[];
  onDocsChange: () => void;
}

export function AdminPanel({ knowledgeBase, onDocsChange }: AdminPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'edit' | 'diff'>('preview');
  const [manualContent, setManualContent] = useState('');
  
  const [instruction, setInstruction] = useState('');
  const [referenceFile, setReferenceFile] = useState<{ name: string; content: string } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  
  // For AI proposed changes
  const [proposedAction, setProposedAction] = useState<{
    intent: 'UPDATE' | 'CREATE';
    folder: string;
    filename: string;
    content: string;
  } | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<{ chunkCount: number } | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchIndexStatus = () => {
    apiFetch('/api/index/status').then(setIndexStatus).catch(() => setIndexStatus(null));
  };
  useEffect(() => { fetchIndexStatus(); }, []);

  const handleTriggerIndex = async () => {
    setIsIndexing(true);
    try {
      await apiFetch('/api/index', { method: 'POST' });
      setTimeout(fetchIndexStatus, 2000);
    } finally {
      setIsIndexing(false);
    }
  };

  // Find the currently selected document
  let selectedDoc: DocFile | null = null;
  let selectedFolder: string | null = null;
  for (const folder of knowledgeBase) {
    for (const file of folder.files) {
      if (file.key === selectedKey) {
        selectedDoc = file;
        selectedFolder = folder.folder;
        break;
      }
    }
    if (selectedDoc) break;
  }

  // Set initial selection if none
  useEffect(() => {
    if (!selectedKey && knowledgeBase.length > 0 && knowledgeBase[0].files.length > 0) {
      setSelectedKey(knowledgeBase[0].files[0].key);
    }
  }, [knowledgeBase, selectedKey]);

  // Reset states when selecting a new file
  useEffect(() => {
    if (selectedDoc) {
      setManualContent(selectedDoc.content || '');
    } else {
      setManualContent('');
    }
    setViewMode('preview');
    setProposedAction(null);
    setInstruction('');
    setReferenceFile(null);
    setError(null);
  }, [selectedKey, selectedDoc]);

  const handleSaveFile = async (folder: string, filename: string, content: string) => {
    try {
      await apiFetch('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ folder, filename, content })
      });
      onDocsChange(); // Refresh the tree
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to save file');
    }
  };

  const handleSaveManual = async () => {
    if (!selectedDoc || !selectedFolder) return;
    await handleSaveFile(selectedFolder, selectedDoc.name, manualContent);
    setViewMode('preview');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setReferenceFile({
        name: file.name,
        content: event.target?.result as string,
      });
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleGenerate = async () => {
    if (!instruction.trim() && !referenceFile) return;
    setIsGenerating(true);
    setError(null);

    try {
      const client = new OpenAI({
        apiKey: getToken() || 'dummy', // Backend injects the real key, we use session token for auth
        baseURL: window.location.origin + '/api/openai/v1',
        dangerouslyAllowBrowser: true
      });
      
      const prompt = `You are an expert HR policy Markdown editor. 
Analyze the user's instruction and reference material.
Determine if the user wants to UPDATE the currently selected document, or CREATE a NEW document.

CURRENT SELECTED DOCUMENT:
Folder: ${selectedFolder || 'None'}
Filename: ${selectedDoc ? selectedDoc.name : 'None'}
Content:
${selectedDoc ? selectedDoc.content : 'None'}

USER INSTRUCTION:
${instruction || 'Update the document based on the reference material.'}

REFERENCE MATERIAL:
${referenceFile ? referenceFile.name + '\n' + referenceFile.content : 'None'}

If the instruction implies modifying the current document, set intent to 'UPDATE', use the same folder and filename, and provide the updated content.
If the instruction implies creating a new policy/document, set intent to 'CREATE', suggest an appropriate folder (e.g., '规章制度', '员工手册', or a new one), suggest a filename ending in .md, and provide the new content.
Return ONLY the raw Markdown content for the 'content' field.`;

      const response = await client.chat.completions.create({
        model: 'dummy',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        tools: [{
          type: "function",
          function: {
            name: "generate_document",
            description: "Generate a document based on the instruction",
            parameters: {
              type: "object",
              properties: {
                intent: { type: "string", enum: ['UPDATE', 'CREATE'], description: "Whether to update the current file or create a new one" },
                folder: { type: "string", description: "The folder name, e.g., '规章制度' or '员工手册'" },
                filename: { type: "string", description: "The file name ending in .md" },
                content: { type: "string", description: "The complete raw Markdown content" }
              },
              required: ['intent', 'folder', 'filename', 'content']
            }
          }
        }],
        tool_choice: { type: "function", function: { name: "generate_document" } }
      });

      if (!response || !response.choices || !response.choices[0]) {
        throw new Error(
          (response as any)?.error?.message || 
          (response as any)?.error || 
          "Invalid response from AI provider: " + JSON.stringify(response)
        );
      }

      const toolCall = response.choices[0].message.tool_calls?.[0] as any;
      if (toolCall && toolCall.function.arguments) {
        const result = JSON.parse(toolCall.function.arguments);
        setProposedAction(result);
        setViewMode(result.intent === 'UPDATE' ? 'diff' : 'preview');
      } else {
        throw new Error('No response from AI.');
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An error occurred during generation.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAcceptAI = async () => {
    if (!proposedAction) return;
    await handleSaveFile(proposedAction.folder, proposedAction.filename, proposedAction.content);
    
    // If it was a new file, we should ideally select it, but for now we just reset
    if (proposedAction.intent === 'CREATE') {
      setSelectedKey(`${proposedAction.folder}/${proposedAction.filename}`);
    }
    
    setProposedAction(null);
    setInstruction('');
    setReferenceFile(null);
    setViewMode('preview');
  };

  const handleRejectAI = () => {
    setProposedAction(null);
    setViewMode('preview');
  };

  const renderDiff = () => {
    if (!proposedAction || !selectedDoc) return null;
    const diffs = diffLines(selectedDoc.content, proposedAction.content);
    
    return (
      <div className="font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">
        {diffs.map((part, index) => {
          const bgColor = part.added ? 'bg-emerald-100/50' : part.removed ? 'bg-rose-100/50' : 'bg-transparent';
          const textColor = part.added ? 'text-emerald-800' : part.removed ? 'text-rose-800' : 'text-slate-600';
          const prefix = part.added ? '+' : part.removed ? '-' : ' ';

          const lines = part.value.replace(/\n$/, '').split('\n');
          return lines.map((line, i) => (
            <div key={`${index}-${i}`} className={cn("flex px-4 py-0.5", bgColor, textColor)}>
              <span className="w-6 select-none opacity-50 text-right pr-2 border-r border-slate-300/50 mr-3">{prefix}</span>
              <span className="whitespace-pre-wrap wrap-break-word flex-1">{line || ' '}</span>
            </div>
          ));
        })}
      </div>
    );
  };

  return (
    <div className="flex h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      {/* Left: File Explorer */}
      <div className="w-64 border-r border-slate-200 bg-slate-50/50 flex flex-col md:flex">
        <div className="p-4 border-b border-slate-200 bg-white space-y-2">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <Folder size={18} className="text-indigo-500" />
            知识库文件
          </h3>
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={handleTriggerIndex}
              disabled={isIndexing}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg disabled:opacity-50"
              title="增量索引：仅处理新增/变更的文档"
            >
              {isIndexing ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
              {isIndexing ? '索引中...' : '索引向量'}
            </button>
            {indexStatus?.chunkCount != null && indexStatus.chunkCount > 0 && (
              <span className="text-xs text-slate-500">{indexStatus.chunkCount} 段</span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {knowledgeBase.map((folder, idx) => (
            <div key={idx}>
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5 px-2">
                <ChevronDown size={16} className="text-slate-400" />
                <Folder size={16} className="text-indigo-400" />
                {folder.folder}
              </div>
              <div className="space-y-0.5 pl-5">
                {folder.files.map(file => (
                  <button
                    key={file.key}
                    onClick={() => setSelectedKey(file.key)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors text-left",
                      selectedKey === file.key 
                        ? "bg-indigo-100 text-indigo-700 font-medium" 
                        : "text-slate-600 hover:bg-slate-200/50"
                    )}
                  >
                    <File size={14} className={selectedKey === file.key ? "text-indigo-500" : "text-slate-400"} />
                    <span className="truncate">{file.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Middle: Editor/Preview/Diff */}
      <div className="flex-1 flex flex-col border-r border-slate-200 overflow-hidden bg-white">
        <div className="flex items-center justify-between p-3 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setViewMode('preview')}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-all",
                viewMode === 'preview' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
              )}
            >
              <Eye size={16} /> 预览
            </button>
            <button
              onClick={() => setViewMode('edit')}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-all",
                viewMode === 'edit' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
              )}
            >
              <Code size={16} /> 手动编辑
            </button>
            {proposedAction?.intent === 'UPDATE' && (
              <button
                onClick={() => setViewMode('diff')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-all",
                  viewMode === 'diff' ? "bg-white text-amber-600 shadow-sm" : "text-amber-600 hover:text-amber-700"
                )}
              >
                <FileText size={16} /> AI 修改对比
              </button>
            )}
          </div>

          {viewMode === 'edit' && (
            <button
              onClick={handleSaveManual}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
            >
              <Save size={16} /> 保存修改
            </button>
          )}
          {proposedAction && (
            <div className="flex items-center gap-2">
              <button 
                onClick={handleRejectAI} 
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
              >
                <X size={16} /> 拒绝
              </button>
              <button 
                onClick={handleAcceptAI} 
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-emerald-600 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors"
              >
                <Check size={16} /> 接受{proposedAction.intent === 'CREATE' ? '新建' : '修改'}
              </button>
            </div>
          )}
        </div>

        {proposedAction?.intent === 'CREATE' && (
          <div className="bg-emerald-50 border-b border-emerald-100 p-3 flex items-center gap-2 text-emerald-700 text-sm">
            <Plus size={16} />
            <span className="font-medium">AI 建议新建文件：</span>
            <span className="font-mono bg-white px-2 py-0.5 rounded border border-emerald-200">{proposedAction.folder} / {proposedAction.filename}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          {viewMode === 'preview' && (
            <div className="markdown-body prose prose-sm max-w-none prose-slate">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {proposedAction?.intent === 'CREATE' ? proposedAction.content : (selectedDoc?.content || '')}
              </ReactMarkdown>
            </div>
          )}
          {viewMode === 'edit' && (
            <textarea
              value={manualContent}
              onChange={(e) => setManualContent(e.target.value)}
              className="w-full h-full min-h-[500px] p-4 font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none"
            />
          )}
          {viewMode === 'diff' && proposedAction?.intent === 'UPDATE' && renderDiff()}
        </div>
      </div>

      {/* Right: AI Assistant */}
      <div className="w-80 flex flex-col bg-slate-50 lg:flex">
        <div className="p-4 border-b border-slate-200 bg-white">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles size={18} className="text-amber-500" />
            AI 辅助修改
          </h3>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">修改指令</label>
            <textarea
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder="例如：将年假天数统一增加2天，或者：根据上传的文件新建一份居家办公制度..."
              className="w-full h-32 p-3 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">参考文件 (可选)</label>
            <input
              type="file"
              accept=".txt,.md,.csv"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
            />
            <div className="flex flex-col gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <Upload size={16} />
                {referenceFile ? '重新上传' : '上传文本文件'}
              </button>
              {referenceFile && (
                <div className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-3 py-2 rounded-lg">
                  <FileText size={14} className="shrink-0" />
                  <span className="text-xs truncate font-medium flex-1" title={referenceFile.name}>
                    {referenceFile.name}
                  </span>
                  <button 
                    onClick={() => setReferenceFile(null)}
                    className="text-indigo-400 hover:text-indigo-600 shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 bg-white">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || (!instruction.trim() && !referenceFile)}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-colors shadow-sm"
          >
            {isGenerating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                AI正在思考...
              </>
            ) : (
              <>
                <Edit3 size={16} />
                生成修改草稿
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
