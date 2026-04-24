import React, { useState, useRef, useEffect } from 'react';
import { Send, User, Bot, Loader2, AlertCircle, FileSearch, FolderTree, RotateCcw, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';
import OpenAI from 'openai';
import { DocFolder } from '../App';
import { apiFetch, getToken } from '../api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: string[];
  agentLogs?: string[];
}

interface ChatProps {
  mode: string;
  modeId: string;
  systemPrompt: string;
  welcomeMessage: string;
  knowledgeBase: DocFolder[];
  threadId: string | null;
  onThreadCreated: (id: string) => void;
  onStartNewChat: () => void;
}

interface PlanItem {
  id: string;
  question: string;
  objective: string;
}

interface ExecutionPlan {
  complexity: 'simple' | 'moderate' | 'complex';
  reasoning: string;
  subQuestions: PlanItem[];
  missingInfo: string[];
}

interface EvidenceItem {
  source: string;
  snippet: string;
  method: 'read_file' | 'search_files' | 'semantic_search';
}

interface ReferenceScore {
  source: string;
  score: number;
}

interface AgentMemorySuggestion {
  id: string;
  score: number;
  successCount: number;
  signature: string;
  retrievalSummary?: string;
  plan?: any;
}

const STARTER_PROMPTS: Record<string, string[]> = {
  qa: ['我这个月的加班费怎么算？', '请帮我梳理请年假的流程和审批节点', '试用期内社保从什么时候开始缴纳？'],
  onboarding: ['新员工第一周我需要完成哪些事项？', '医院考勤打卡与迟到规则是怎样的？', '入职后常见系统账号开通流程是什么？'],
  policy: ['请把职称评审政策用 5 条讲清楚', '绩效考核政策中最容易忽略的注意点有哪些？', '休假制度适用对象和限制条件分别是什么？'],
  career: ['我现在是住院医，3 年内怎么规划晋升？', '如何制定可执行的季度能力提升计划？', '想走管理岗，需要重点补哪些能力？'],
  compliance: ['拟定调岗降薪方案时有哪些法律风险？', '解除劳动合同前应该先完成哪些合规动作？', '排班加班制度怎么设计更合规？']
};

export function Chat({ mode, modeId, systemPrompt, welcomeMessage, knowledgeBase, threadId, onThreadCreated, onStartNewChat }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [expandedAgentLogs, setExpandedAgentLogs] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const parseJsonSafely = <T,>(value: string, fallback: T): T => {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };

  const parseToolArguments = (value: string): Record<string, any> => {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const compressReferences = (
    sources: Set<string>,
    evidenceItems: EvidenceItem[],
    maxItems = 8
  ): string[] => {
    const sourceScoreMap = new Map<string, number>();
    for (const item of evidenceItems) {
      if (!item.source) continue;
      sourceScoreMap.set(item.source, (sourceScoreMap.get(item.source) || 0) + 1);
    }
    for (const src of sources) {
      if (!sourceScoreMap.has(src)) sourceScoreMap.set(src, 1);
    }

    const scored: ReferenceScore[] = Array.from(sourceScoreMap.entries())
      .map(([source, score]) => ({ source, score }))
      .sort((a, b) => b.score - a.score);

    const asLabel = (path: string) => {
      const clean = path.replace(/^\//, '');
      const segs = clean.split('/');
      if (segs.length <= 1) return clean;
      return `${segs[0]}/${segs[segs.length - 1]}`;
    };

    if (scored.length <= maxItems) {
      return scored.map((item) => asLabel(item.source));
    }

    const head = scored.slice(0, Math.max(4, maxItems - 2)).map((item) => asLabel(item.source));
    const tail = scored.slice(Math.max(4, maxItems - 2));
    const grouped = new Map<string, number>();
    for (const item of tail) {
      const clean = item.source.replace(/^\//, '');
      const folder = clean.includes('/') ? clean.split('/')[0] : '其他';
      grouped.set(folder, (grouped.get(folder) || 0) + 1);
    }
    const tailSummary = Array.from(grouped.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([folder, count]) => `${folder}(${count})`)
      .join('、');

    return [...head, `其余 ${tail.length} 个来源已压缩：${tailSummary || '其他'}`];
  };

  // Reset chat when mode or thread changes
  useEffect(() => {
    const loadThread = async () => {
      if (threadId) {
        try {
          const data = await apiFetch(`/api/chat/threads/${threadId}/messages`);
          if (data.length > 0) {
            setMessages(data);
          } else {
            setMessages([{ id: 'welcome', role: 'assistant', content: welcomeMessage }]);
          }
        } catch (e) {
          console.error('Failed to load thread messages', e);
        }
      } else {
        setMessages([{ id: 'welcome', role: 'assistant', content: welcomeMessage }]);
      }
    };
    
    loadThread();
    setError(null);
    setInput('');
    setExpandedAgentLogs({});
  }, [mode, welcomeMessage, threadId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, agentStatus]);

  const autoResizeInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  useEffect(() => {
    autoResizeInput();
  }, [input]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setAgentStatus('正在思考...');
    setError(null);

    let currentThreadId = threadId;

    try {
      if (!currentThreadId) {
        const threadRes = await apiFetch('/api/chat/threads', {
          method: 'POST',
          body: JSON.stringify({ mode_id: modeId, title: userMessage.content.slice(0, 30) }),
        });
        currentThreadId = threadRes.id;
        onThreadCreated(threadRes.id);
      }

      await apiFetch(`/api/chat/threads/${currentThreadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: userMessage.content }),
      });

      const client = new OpenAI({
        apiKey: getToken() || 'dummy', // Backend injects the real key, we use session token for auth
        baseURL: window.location.origin + '/api/openai/v1',
        dangerouslyAllowBrowser: true
      });
      
      const tools = [{
        type: "function",
        function: {
          name: "list_directory",
          description: "List the contents of a directory in the knowledge base. Use this to explore available folders and files. The root directory is '/'.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The path to list, e.g., '/' for root, or '/规章制度' for a specific folder." }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read the content of a specific markdown file in the knowledge base.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "The full path of the file to read, e.g., '/规章制度/考勤与休假管理办法.md'." }
            },
            required: ["filePath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_files",
          description: "Search for a specific text pattern or keyword across all files in the knowledge base (like grep). Returns a list of files that contain the match, along with a short snippet.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The text or keyword to search for." }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "semantic_search",
          description: "Search for concepts, meanings, or semantic intent across the knowledge base. Use this when you are looking for an idea rather than an exact keyword.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The concept or question to search for semantically." }
            },
            required: ["query"]
          }
        }
      }];

      const planningPrompt = `你是一个问题分解规划器。请先判断用户问题复杂度，并拆分为可检索的子问题。
必须返回 JSON（不要 markdown，不要解释）：
{
  "complexity": "simple|moderate|complex",
  "reasoning": "一句话说明为什么这么拆分",
  "subQuestions": [{"id":"Q1","question":"...","objective":"..."}],
  "missingInfo": ["若问题存在必要前提缺失，列出来"]
}
要求：
1) simple 最多 1-2 个子问题，complex 可 3-5 个子问题；
2) 子问题要覆盖：定义/范围、条件限制、例外条款、流程时序（若适用）；
3) 如果用户问题本身已很具体，也要保证至少 1 个子问题。

用户问题：${userMessage.content}`;

      let memoryHints: AgentMemorySuggestion[] = [];
      try {
        const memoryResp = await apiFetch('/api/agent-memory/suggest', {
          method: 'POST',
          body: JSON.stringify({ question: userMessage.content })
        });
        memoryHints = Array.isArray(memoryResp?.items) ? memoryResp.items.slice(0, 3) : [];
      } catch (e) {
        console.warn('Agent memory suggest failed:', e);
      }
      if (memoryHints.length > 0) {
        setAgentStatus('正在加载历史稳定策略...');
      }

      const planningPromptWithMemory = `${planningPrompt}

历史稳定策略（可参考，不可照抄）：
${memoryHints.length > 0 ? JSON.stringify(memoryHints.map((m) => ({
  successCount: m.successCount,
  signature: m.signature,
  retrievalSummary: m.retrievalSummary,
  plan: m.plan
})), null, 2) : '无'}`;

      setAgentStatus('正在规划检索路径...');
      const planningResponse = await client.chat.completions.create({
        model: 'dummy',
        messages: [{ role: 'user', content: planningPromptWithMemory }],
        temperature: 0.1,
        enable_thinking: false,
        tool_choice: 'none',
      } as any);

      const rawPlan = planningResponse?.choices?.[0]?.message?.content || '';
      let parsedPlan = parseJsonSafely<ExecutionPlan>(rawPlan, {
        complexity: 'moderate',
        reasoning: '默认使用单步检索后综合回答。',
        subQuestions: [{ id: 'Q1', question: userMessage.content, objective: '直接回答用户问题' }],
        missingInfo: []
      });
      if (!Array.isArray(parsedPlan.subQuestions) || parsedPlan.subQuestions.length === 0) {
        const repairResponse = await client.chat.completions.create({
          model: 'dummy',
          messages: [{
            role: 'user',
            content: `将下列文本转换为严格 JSON，字段必须是 complexity/reasoning/subQuestions/missingInfo，且 subQuestions 至少 1 条：\n${rawPlan}`
          }],
          temperature: 0,
          enable_thinking: false,
          tool_choice: 'none',
        } as any);
        const repairedContent = repairResponse?.choices?.[0]?.message?.content || '';
        parsedPlan = parseJsonSafely<ExecutionPlan>(repairedContent, parsedPlan);
      }
      const normalizedPlan: ExecutionPlan = {
        complexity: parsedPlan.complexity || 'moderate',
        reasoning: parsedPlan.reasoning || '默认规划',
        subQuestions: Array.isArray(parsedPlan.subQuestions) && parsedPlan.subQuestions.length > 0
          ? parsedPlan.subQuestions.slice(0, 5)
          : [{ id: 'Q1', question: userMessage.content, objective: '直接回答用户问题' }],
        missingInfo: Array.isArray(parsedPlan.missingInfo) ? parsedPlan.missingInfo.slice(0, 5) : []
      };

      const agentInstruction = `${systemPrompt}

You have access to the company's knowledge base file system. You MUST use the provided tools (list_directory, read_file, search_files, semantic_search) to navigate the directories, find relevant files, and read their contents to answer the user's question.
Think step-by-step like an agent. Combine exact search (search_files) and semantic search (semantic_search) to find the best information. Do not guess information.

Execution plan (must follow):
${JSON.stringify(normalizedPlan, null, 2)}

Boundary requirements (critical):
- Distinguish clearly between "known with evidence" and "unknown / insufficient evidence".
- Every key conclusion must have at least one evidence reference from tools.
- If evidence is insufficient, explicitly say what is unknown and what extra info/doc is needed.

CRITICAL - Final Answer Requirement:
- When calling tools, do NOT output content like "让我搜索" or "正在分析" - keep content empty or minimal.
- When you have enough information, STOP calling tools and output ONLY your final answer: a clear, comprehensive, structured response that directly answers the user's question.
- Your final response MUST be the actual answer (e.g. steps, conditions, procedures), NOT your retrieval process or intentions.`;

      // Build history
      const openAiMessages: any[] = [
        { role: 'system', content: agentInstruction },
        ...messages.filter(m => m.id !== 'welcome').map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        { role: 'user', content: userMessage.content }
      ];

      let response = await client.chat.completions.create({
        model: 'dummy',
        messages: openAiMessages,
        tools: tools as any,
        temperature: 0.2,
        enable_thinking: false, // 关闭思考模式以加快响应（SiliconFlow 等默认开启）
      } as any);

      if (!response || !response.choices || !response.choices[0]) {
        throw new Error(
          (response as any)?.error?.message || 
          (response as any)?.error || 
          "Invalid response from AI provider: " + JSON.stringify(response)
        );
      }

      let referencedTitles = new Set<string>();
      const referencedSources = new Set<string>();
      let agentLogs: string[] = [];
      const evidenceBoardMap = new Map<string, EvidenceItem>();
      const pushEvidence = (evidence: EvidenceItem) => {
        const trimmedSnippet = evidence.snippet.replace(/\s+/g, ' ').trim().slice(0, 280);
        if (!trimmedSnippet) return;
        const key = `${evidence.method}|${evidence.source}|${trimmedSnippet}`;
        if (!evidenceBoardMap.has(key)) {
          evidenceBoardMap.set(key, { ...evidence, snippet: trimmedSnippet });
        }
      };
      const pushReferenceFromPath = (filePath: string) => {
        referencedSources.add(filePath);
        const title = filePath.split('/').filter(Boolean).pop();
        if (title) referencedTitles.add(title);
      };
      agentLogs.push(`规划复杂度: ${normalizedPlan.complexity}`);
      agentLogs.push(`规划说明: ${normalizedPlan.reasoning}`);
      if (memoryHints.length > 0) {
        agentLogs.push(`命中历史稳定策略: ${memoryHints.map((m) => `${m.signature}(x${m.successCount})`).join(' | ')}`);
      }
      normalizedPlan.subQuestions.forEach((q) => {
        agentLogs.push(`子问题 ${q.id}: ${q.question}`);
      });
      normalizedPlan.missingInfo.forEach((item) => {
        agentLogs.push(`待补充信息: ${item}`);
      });
      let loopCount = 0;
      const MAX_LOOPS = Math.min(12, Math.max(6, normalizedPlan.subQuestions.length * 3));

      while (response.choices[0].message.tool_calls && response.choices[0].message.tool_calls.length > 0 && loopCount < MAX_LOOPS) {
        loopCount++;
        
        const message = response.choices[0].message;
        openAiMessages.push(message);
        
        for (const call of message.tool_calls as any[]) {
          let result: any = {};
          const args = parseToolArguments(call.function.arguments);
          
          if (call.function.name === 'list_directory') {
            const path = args.path || '/';
            setAgentStatus(`正在检索目录: ${path}`);
            agentLogs.push(`检索目录: ${path}`);
            
            if (path === '/' || path === '') {
              result = { folders: knowledgeBase.map(f => f.folder) };
            } else {
              const folderName = path.replace(/^\//, '');
              const folder = knowledgeBase.find(f => f.folder === folderName);
              if (folder) {
                result = { files: folder.files.map(f => f.name) };
              } else {
                result = { error: "Directory not found" };
              }
            }
          } else if (call.function.name === 'read_file') {
            const filePath = args.filePath || '';
            setAgentStatus(`正在阅读文件: ${filePath}`);
            agentLogs.push(`阅读文件: ${filePath}`);
            
            const cleanPath = filePath.replace(/^\//, '');
            let found = false;
            for (const folder of knowledgeBase) {
              for (const file of folder.files) {
                if (file.key === cleanPath || `${folder.folder}/${file.name}` === cleanPath) {
                  result = { content: file.content };
                  pushReferenceFromPath(`/${folder.folder}/${file.name}`);
                  referencedTitles.add(file.name);
                  pushEvidence({
                    source: `/${folder.folder}/${file.name}`,
                    snippet: file.content.substring(0, 400),
                    method: 'read_file'
                  });
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (!found) {
              result = { error: "File not found" };
            }
          } else if (call.function.name === 'search_files') {
            const query = args.query || '';
            setAgentStatus(`正在全局检索: "${query}"`);
            agentLogs.push(`全局检索: "${query}"`);
            
            if (!query) {
              result = { error: "Empty query" };
            } else {
              const matches: any[] = [];
              const lowerQuery = query.toLowerCase();
              
              for (const folder of knowledgeBase) {
                for (const file of folder.files) {
                  if (file.content.toLowerCase().includes(lowerQuery)) {
                    const idx = file.content.toLowerCase().indexOf(lowerQuery);
                    const start = Math.max(0, idx - 40);
                    const end = Math.min(file.content.length, idx + query.length + 40);
                    let snippet = file.content.substring(start, end).replace(/\n/g, ' ');
                    if (start > 0) snippet = '...' + snippet;
                    if (end < file.content.length) snippet = snippet + '...';
                    
                    matches.push({
                      filePath: `/${folder.folder}/${file.name}`,
                      snippet
                    });
                    pushEvidence({
                      source: `/${folder.folder}/${file.name}`,
                      snippet,
                      method: 'search_files'
                    });
                    pushReferenceFromPath(`/${folder.folder}/${file.name}`);
                  }
                }
              }
              
              if (matches.length > 0) {
                result = { matches: matches.slice(0, 5) }; // Limit to top 5 matches
              } else {
                result = { message: "No matches found." };
              }
            }
          } else if (call.function.name === 'semantic_search') {
            const query = args.query || '';
            setAgentStatus(`正在语义检索: "${query}"`);
            agentLogs.push(`语义检索: "${query}"`);
            
            if (!query) {
              result = { error: "Empty query" };
            } else {
              try {
                const searchResp = await apiFetch('/api/semantic-search', {
                  method: 'POST',
                  body: JSON.stringify({ query })
                });
                if (searchResp.matches) {
                  result = {
                    matches: searchResp.matches.slice(0, 3).map((m: { filePath: string; snippet: string; similarityScore: string }) => ({
                      filePath: m.filePath,
                      snippet: m.snippet,
                      similarityScore: m.similarityScore
                    }))
                  };
                  for (const m of searchResp.matches.slice(0, 3)) {
                    pushEvidence({
                      source: m.filePath,
                      snippet: m.snippet,
                      method: 'semantic_search'
                    });
                    pushReferenceFromPath(m.filePath);
                  }
                } else {
                  result = searchResp.error ? { error: searchResp.error } : { message: "No matches found." };
                }
              } catch (err) {
                console.error("Semantic search error:", err);
                result = { error: String(err) };
              }
            }
          } else {
            result = { error: `Unsupported tool: ${call.function.name}` };
            agentLogs.push(`未知工具调用: ${call.function.name}`);
          }
          
          openAiMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result)
          });
        }
        
        setAgentStatus('正在分析内容...');
        response = await client.chat.completions.create({
          model: 'dummy',
          messages: openAiMessages,
          tools: tools as any,
          temperature: 0.2,
          enable_thinking: false,
        } as any);

        if (!response || !response.choices || !response.choices[0]) {
          throw new Error(
            (response as any)?.error?.message || 
            (response as any)?.error || 
            "Invalid response from AI provider: " + JSON.stringify(response)
          );
        }
      }

      let finalContent = (response.choices[0].message.content || '').trim();
      const hasRetrievedInfo = referencedTitles.size > 0 || agentLogs.length > 0;
      // 若内容为空或仅包含"让我搜索"等中间意图，且已有检索结果，则强制合成最终回答
      const looksLikeIntermediate = !finalContent || /^(现在)?(让我|正在)(搜索|检索|分析|查找)/.test(finalContent) || (finalContent.length < 80 && /搜索|检索|分析/.test(finalContent));
      const needsSynthesis = hasRetrievedInfo && (looksLikeIntermediate || (loopCount >= MAX_LOOPS && response.choices[0].message.tool_calls?.length));

      if (needsSynthesis) {
        setAgentStatus('正在生成最终回答...');
        openAiMessages.push({
          role: 'user',
          content: '请根据上述检索到的所有文档内容，用清晰的结构化 Markdown 格式直接回答用户的原始问题。只输出最终答案，不要输出任何检索过程或"让我搜索"等内容。'
        });
        const synthResponse = await client.chat.completions.create({
          model: 'dummy',
          messages: openAiMessages,
          tools: tools as any,
          tool_choice: 'none',
          temperature: 0.2,
          enable_thinking: false,
        } as any);
        if (synthResponse?.choices?.[0]?.message?.content) {
          finalContent = synthResponse.choices[0].message.content.trim();
        }
      }

      setAgentStatus('正在执行边界校验...');
      const evidenceBoard = Array.from(evidenceBoardMap.values());
      const evidenceDigest = evidenceBoard.slice(0, 18).map((e, idx) =>
        `${idx + 1}. [${e.method}] ${e.source}: ${e.snippet.replace(/\s+/g, ' ').slice(0, 180)}`
      ).join('\n');
      const boundaryPrompt = `请对下面答案做“已知/未知边界校验”，输出最终 markdown 答案。

用户原问题：
${userMessage.content}

执行规划：
${JSON.stringify(normalizedPlan, null, 2)}

可用证据摘录：
${evidenceDigest || '（无）'}

草稿答案：
${finalContent || '（无）'}

输出要求（必须满足）：
1) 先给“结论摘要”；
2) 再给“已确认信息（有依据）”；
3) 再给“尚不确定/缺失信息”；
4) 若证据不足，明确给出“建议补充材料或人工确认项”；
5) 不要编造未提供的政策条款。`;
      const boundaryResponse = await client.chat.completions.create({
        model: 'dummy',
        messages: [{ role: 'user', content: boundaryPrompt }],
        temperature: 0.1,
        enable_thinking: false,
        tool_choice: 'none',
      } as any);
      const boundaryContent = boundaryResponse?.choices?.[0]?.message?.content?.trim();
      if (boundaryContent) {
        finalContent = boundaryContent;
      }

      if (finalContent) {
        const evidenceBoard = Array.from(evidenceBoardMap.values());
        const compressedReferences = compressReferences(referencedSources, evidenceBoard);
        if (compressedReferences.some((item) => item.includes('已压缩'))) {
          agentLogs.push(`参考来源已压缩: ${compressedReferences[compressedReferences.length - 1]}`);
        }
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: finalContent,
          references: compressedReferences.length > 0 ? compressedReferences : Array.from(referencedTitles),
          agentLogs: agentLogs.length > 0 ? agentLogs : undefined
        };
        setMessages((prev) => [...prev, assistantMessage]);

        try {
          await apiFetch('/api/agent-memory/record', {
            method: 'POST',
            body: JSON.stringify({
              question: userMessage.content,
              plan: normalizedPlan,
              retrievalSummary: `loops=${loopCount}; refs=${compressedReferences.length}; evidence=${evidenceBoard.length}`,
              success: true
            })
          });
        } catch (e) {
          console.warn('Agent memory record failed:', e);
        }

        if (currentThreadId) {
          await apiFetch(`/api/chat/threads/${currentThreadId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              role: 'assistant',
              content: assistantMessage.content,
              references: assistantMessage.references,
              agentLogs: assistantMessage.agentLogs
            }),
          });
        }
      } else {
        throw new Error('No response received from the model.');
      }
    } catch (err) {
      console.error('Chat error:', err);
      let errorMessage = 'An unexpected error occurred.';
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message);
          if (parsed.error && parsed.error.code === 429) {
            errorMessage = 'API 额度已耗尽 (Quota Exceeded)。请稍等一两分钟后再试，或检查您的 API Key 额度。';
          } else if (parsed.error && parsed.error.message) {
            errorMessage = parsed.error.message;
          } else {
            errorMessage = err.message;
          }
        } catch (e) {
          // Not JSON
          if (err.message.includes('429') || err.message.toLowerCase().includes('quota') || err.message.toLowerCase().includes('rate limit')) {
            errorMessage = 'API 额度已耗尽 (Quota Exceeded)。请稍等一两分钟后再试，或检查您的 API Key 额度。';
          } else {
            errorMessage = err.message;
          }
        }
      } else {
        errorMessage = String(err);
      }
      setError(errorMessage);
    } finally {
      setIsLoading(false);
      setAgentStatus('');
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const handleQuickPrompt = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const isFreshConversation = !threadId && messages.length <= 1;
  const starterPrompts = STARTER_PROMPTS[modeId] || STARTER_PROMPTS.qa;

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">{mode}</h2>
            <p className="text-sm text-slate-500">AI-powered HR Assistant (Agentic Retrieval)</p>
          </div>
          <button
            onClick={onStartNewChat}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-white"
          >
            <RotateCcw size={14} />
            重新开始
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex gap-4 max-w-[85%]",
              msg.role === 'user' ? "ml-auto flex-row-reverse" : ""
            )}
          >
            <div className={cn(
              "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
              msg.role === 'user' ? "bg-indigo-100 text-indigo-600" : "bg-emerald-100 text-emerald-600"
            )}>
              {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
            </div>
            <div className={cn(
              "px-4 py-3 rounded-2xl flex flex-col gap-2",
              msg.role === 'user' 
                ? "bg-indigo-600 text-white rounded-tr-sm" 
                : "bg-slate-100 text-slate-800 rounded-tl-sm"
            )}>
              {msg.role === 'user' ? (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <>
                  <div className="markdown-body prose prose-sm max-w-none prose-slate">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                  
                  {msg.agentLogs && msg.agentLogs.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200/60">
                      <button
                        onClick={() =>
                          setExpandedAgentLogs((prev) => ({
                            ...prev,
                            [msg.id]: !prev[msg.id]
                          }))
                        }
                        className="text-xs text-slate-500 flex items-center gap-1.5 font-medium mb-1.5 hover:text-slate-700"
                      >
                        <FolderTree size={14} className="text-indigo-500" />
                        {expandedAgentLogs[msg.id] ? '隐藏 Agent 检索路径' : '查看 Agent 检索路径'}
                      </button>
                      {expandedAgentLogs[msg.id] && (
                        <ul className="space-y-1">
                          {msg.agentLogs.map((log, idx) => (
                            <li key={idx} className="text-[11px] text-slate-500 font-mono bg-slate-200/50 px-2 py-1 rounded">
                              &gt; {log}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {msg.references && msg.references.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-200/60">
                      <p className="text-xs text-slate-500 flex items-center gap-1.5 font-medium">
                        <FileSearch size={14} className="text-emerald-600" />
                        最终参考文档：
                      </p>
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {msg.references.map((ref, idx) => (
                          <li key={idx} className="text-[11px] bg-white border border-slate-200 px-2 py-0.5 rounded-md text-slate-600">
                            {ref}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex gap-4 max-w-[85%]">
            <div className="shrink-0 w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <Bot size={18} />
            </div>
            <div className="px-4 py-3 rounded-2xl bg-slate-100 text-slate-800 rounded-tl-sm flex items-center gap-2">
              <Loader2 size={16} className="animate-spin text-slate-500" />
              <span className="text-sm text-slate-500">
                {agentStatus || '正在生成解答...'}
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 p-4 text-red-600 bg-red-50 rounded-xl text-sm mx-auto max-w-md">
            <AlertCircle size={16} />
            <p>{error}</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-white border-t border-slate-100">
        {isFreshConversation && (
          <div className="mb-3">
            <p className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
              <Sparkles size={14} className="text-amber-500" />
              推荐你这样提问（点击即填入）：
            </p>
            <div className="flex flex-wrap gap-2">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => handleQuickPrompt(prompt)}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="relative flex items-center">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            rows={1}
            placeholder="输入您的问题...（Enter 发送，Shift+Enter 换行）"
            className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            <Send size={20} />
          </button>
        </form>
        <div className="mt-2 text-center">
          <p className="text-xs text-slate-400">AI 生成内容仅供参考，复杂情况可申请转人工服务。</p>
        </div>
      </div>
    </div>
  );
}
