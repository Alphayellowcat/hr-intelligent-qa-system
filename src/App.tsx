import React, { useState, useEffect } from 'react';
import { 
  MessageSquare, 
  UserPlus, 
  FileText, 
  TrendingUp, 
  ShieldCheck,
  Menu,
  X,
  Database,
  LogOut,
  PlusCircle,
  MessageCircle,
  Trash2
} from 'lucide-react';
import { Chat } from './components/Chat';
import { AdminPanel } from './components/AdminPanel';
import { Login } from './components/Login';
import { Settings } from './components/Settings';
import { cn } from './lib/utils';
import { apiFetch, removeToken, getToken } from './api';

export interface DocFile {
  key: string;
  name: string;
  content: string;
}

export interface DocFolder {
  folder: string;
  files: DocFile[];
}

const MODULES = [
  {
    id: 'qa',
    title: '24小时HR自助问答',
    icon: MessageSquare,
    description: '查询薪资福利、休假政策、职称评审政策等',
    systemPrompt: `你是一个专业的医院人力资源（HR）智能助手。你的任务是为员工提供24小时自助问答服务。
你可以回答关于薪资福利、休假政策、职称评审政策等常见HR问题。
请保持专业、热情、准确的语气。如果遇到极其复杂或特殊的情况，请建议员工联系人工HR（分机号：8001）。
请用清晰的Markdown格式输出，使用列表和加粗来突出重点。`,
    welcomeMessage: '您好！我是您的24小时HR智能助手。您可以向我查询关于薪资福利、休假政策、职称评审等相关问题。请问有什么我可以帮您的？'
  },
  {
    id: 'onboarding',
    title: '智能入职引导',
    icon: UserPlus,
    description: '新员工快速了解医院文化、规章制度、工作流程',
    systemPrompt: `你是一个医院的新员工入职引导AI助手。你的任务是帮助新员工快速融入医院环境。
你需要向新员工介绍医院的文化、核心价值观、基本规章制度（如考勤、着装要求）以及入职后的基本工作流程（如办理工牌、领取办公用品、开通系统账号等）。
语气要亲切、鼓励、有耐心，让新员工感受到温暖。
请用清晰的Markdown格式输出。`,
    welcomeMessage: '欢迎加入我们医院大家庭！我是您的专属入职引导助手。我可以为您介绍医院文化、规章制度或入职流程。您想先了解哪方面的内容呢？'
  },
  {
    id: 'policy',
    title: '政策快速解读',
    icon: FileText,
    description: '人力资源政策简化解释，提高理解效率',
    systemPrompt: `你是一个专业的医院人力资源政策解读专家。你的任务是将复杂、晦涩的官方人力资源政策文件转化为通俗易懂的语言。
当员工询问某项政策时，你需要提炼出核心要点（如：适用对象、申请条件、办理流程、注意事项）。
如果问题过于复杂或涉及严重争议，请提示员工转接人工服务。
请使用结构化的Markdown格式，确保条理清晰。`,
    welcomeMessage: '您好！我是政策解读助手。如果您对某项HR政策（如绩效考核办法、培训管理规定等）感到困惑，请告诉我，我将为您提炼核心要点并进行通俗易懂的解释。'
  },
  {
    id: 'career',
    title: '职业发展路径规划',
    icon: TrendingUp,
    description: '提供个性化职业成长建议与能力提升方案',
    systemPrompt: `你是一个资深的医院员工职业发展规划师。你的任务是为医护人员、行政人员等提供个性化的职业成长建议。
你需要根据员工目前的岗位、资历和目标，提供具体的晋升路径（如职称晋升）、需要考取的资格证书、建议参加的培训项目以及日常能力提升的具体建议。
语气要专业、具有启发性和指导性。
请使用Markdown格式，提供清晰的步骤和建议列表。`,
    welcomeMessage: '您好！我是您的职业发展规划师。无论您是想了解职称晋升路径，还是希望获取能力提升的建议，都可以告诉我您目前的岗位和目标，我将为您量身定制发展规划。'
  },
  {
    id: 'compliance',
    title: '政策合规检查',
    icon: ShieldCheck,
    description: '确保人力资源操作、制度拟定符合法律法规',
    systemPrompt: `你是一个精通中国劳动法及医疗行业相关法规的HR合规与风险管控专家。
你的任务是协助HR部门或管理人员进行政策合规检查。你需要评估拟定的人力资源操作（如解除劳动合同、调岗降薪、排班加班等）或新制度是否符合现行法律法规，并指出潜在的法律风险。
请务必严谨、客观。在回答末尾，请添加免责声明：“注：AI分析仅供参考，最终决策请咨询专业法律顾问。”
请使用Markdown格式输出。`,
    welcomeMessage: '您好！我是HR合规与风险管控专家。您可以将拟定的HR操作方案或制度草案发送给我，我将为您进行初步的法律法规合规性检查，并提示潜在风险。'
  }
];

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  
  const [activeModule, setActiveModule] = useState(MODULES[0]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [currentView, setCurrentView] = useState<'chat' | 'admin' | 'settings'>('chat');
  const [knowledgeBase, setKnowledgeBase] = useState<DocFolder[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  
  const [threads, setThreads] = useState<any[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      if (!getToken()) {
        setIsAuthChecking(false);
        return;
      }
      try {
        const data = await apiFetch('/api/auth/me');
        setUser(data.user);
      } catch (err) {
        removeToken();
      } finally {
        setIsAuthChecking(false);
      }
    };
    checkAuth();
  }, []);

  const fetchDocs = async () => {
    try {
      setIsLoadingDocs(true);
      const res = await apiFetch('/api/docs');
      setKnowledgeBase(res);
    } catch (error) {
      console.error('Failed to fetch docs:', error);
    } finally {
      setIsLoadingDocs(false);
    }
  };

  const fetchThreads = async () => {
    try {
      const data = await apiFetch('/api/chat/threads');
      setThreads(data);
    } catch (error) {
      console.error('Failed to fetch threads:', error);
    }
  };

  const handleDeleteThread = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await apiFetch(`/api/chat/threads/${id}`, { method: 'DELETE' });
      if (currentThreadId === id) {
        setCurrentThreadId(null);
      }
      fetchThreads();
    } catch (error) {
      console.error('Failed to delete thread:', error);
    }
  };

  useEffect(() => {
    if (user) {
      fetchDocs();
      fetchThreads();
    }
  }, [user]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    removeToken();
    setUser(null);
    setThreads([]);
    setCurrentThreadId(null);
  };

  const createNewChat = () => {
    setCurrentThreadId(null);
    setCurrentView('chat');
    if (window.innerWidth < 1024) setIsSidebarOpen(false);
  };

  if (isAuthChecking) {
    return <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-500">加载中...</div>;
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Mobile sidebar overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/20 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-30 w-72 bg-white border-r border-slate-200 transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:flex-shrink-0 flex flex-col",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-indigo-900 tracking-tight">人事智能QA系统</h1>
            <p className="text-xs text-slate-500 mt-1 font-medium tracking-wide uppercase">HR Intelligent Assistant</p>
          </div>
          <button 
            className="lg:hidden p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-50"
            onClick={() => setIsSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          <div className="px-4 mb-2">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">员工服务方面</h2>
          </div>
          <nav className="px-3 space-y-1 mb-6">
            {MODULES.slice(0, 4).map((mod) => (
              <button
                key={mod.id}
                onClick={() => {
                  setActiveModule(mod);
                  createNewChat();
                }}
                className={cn(
                  "w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                  currentView === 'chat' && activeModule.id === mod.id && !currentThreadId
                    ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100" 
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <mod.icon className={cn(
                  "flex-shrink-0 mt-0.5",
                  currentView === 'chat' && activeModule.id === mod.id ? "text-indigo-600" : "text-slate-400"
                )} size={20} />
                <div>
                  <div className="font-medium text-sm">{mod.title}</div>
                  <div className={cn(
                    "text-xs mt-0.5 line-clamp-2",
                    currentView === 'chat' && activeModule.id === mod.id ? "text-indigo-500" : "text-slate-400"
                  )}>
                    {mod.description}
                  </div>
                </div>
              </button>
            ))}
          </nav>

          <div className="px-4 mb-2">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">合规与风险管控</h2>
          </div>
          <nav className="px-3 space-y-1 mb-6">
            {MODULES.slice(4).map((mod) => (
              <button
                key={mod.id}
                onClick={() => {
                  setActiveModule(mod);
                  createNewChat();
                }}
                className={cn(
                  "w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                  currentView === 'chat' && activeModule.id === mod.id && !currentThreadId
                    ? "bg-emerald-50 text-emerald-700 shadow-sm ring-1 ring-emerald-100" 
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <mod.icon className={cn(
                  "flex-shrink-0 mt-0.5",
                  currentView === 'chat' && activeModule.id === mod.id ? "text-emerald-600" : "text-slate-400"
                )} size={20} />
                <div>
                  <div className="font-medium text-sm">{mod.title}</div>
                  <div className={cn(
                    "text-xs mt-0.5 line-clamp-2",
                    currentView === 'chat' && activeModule.id === mod.id ? "text-emerald-500" : "text-slate-400"
                  )}>
                    {mod.description}
                  </div>
                </div>
              </button>
            ))}
          </nav>

          {threads.length > 0 && (
            <>
              <div className="px-4 mb-2 pt-4 border-t border-slate-100">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">历史对话</h2>
              </div>
              <nav className="px-3 space-y-1 mb-6">
                {threads.map((thread) => (
                  <div
                    key={thread.id}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-all duration-200 group cursor-pointer",
                      currentView === 'chat' && currentThreadId === thread.id
                        ? "bg-slate-100 text-slate-900 font-medium"
                        : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                    )}
                    onClick={() => {
                      const mod = MODULES.find(m => m.id === thread.mode_id) || MODULES[0];
                      setActiveModule(mod);
                      setCurrentThreadId(thread.id);
                      setCurrentView('chat');
                      if (window.innerWidth < 1024) setIsSidebarOpen(false);
                    }}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <MessageCircle size={16} className="flex-shrink-0" />
                      <span className="text-sm truncate">{thread.title || '新对话'}</span>
                    </div>
                    <button
                      onClick={(e) => handleDeleteThread(e, thread.id)}
                      className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition-all"
                      title="删除对话"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </nav>
            </>
          )}

          {user?.role === 'admin' && (
            <>
              <div className="px-4 mb-2 pt-4 border-t border-slate-100">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">系统管理</h2>
              </div>
              <nav className="px-3 space-y-1">
                <button
                  onClick={() => {
                    setCurrentView('admin');
                    setCurrentThreadId(null);
                    if (window.innerWidth < 1024) setIsSidebarOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                    currentView === 'admin'
                      ? "bg-amber-50 text-amber-700 shadow-sm ring-1 ring-amber-100"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  )}
                >
                  <Database className={cn(
                    "flex-shrink-0 mt-0.5",
                    currentView === 'admin' ? "text-amber-600" : "text-slate-400"
                  )} size={20} />
                  <div>
                    <div className="font-medium text-sm">知识库管理</div>
                    <div className={cn(
                      "text-xs mt-0.5 line-clamp-2",
                      currentView === 'admin' ? "text-amber-500" : "text-slate-400"
                    )}>
                      AI辅助维护Markdown文档
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => {
                    setCurrentView('settings');
                    setCurrentThreadId(null);
                    if (window.innerWidth < 1024) setIsSidebarOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                    currentView === 'settings'
                      ? "bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  )}
                >
                  <ShieldCheck className={cn(
                    "flex-shrink-0 mt-0.5",
                    currentView === 'settings' ? "text-indigo-600" : "text-slate-400"
                  )} size={20} />
                  <div>
                    <div className="font-medium text-sm">模型设置</div>
                    <div className={cn(
                      "text-xs mt-0.5 line-clamp-2",
                      currentView === 'settings' ? "text-indigo-500" : "text-slate-400"
                    )}>
                      配置硅基流动等API
                    </div>
                  </div>
                </button>
              </nav>
            </>
          )}
        </div>
        
        <div className="p-4 border-t border-slate-100">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm uppercase">
              {user.username.slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900 truncate">{user.username}</p>
              <p className="text-xs text-slate-500 truncate">{user.role === 'admin' ? '管理员' : '员工'}</p>
            </div>
            <button 
              onClick={handleLogout}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
              title="退出登录"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50/50">
        {/* Mobile Header */}
        <header className="lg:hidden flex items-center justify-between p-4 bg-white border-b border-slate-200">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 -ml-2 text-slate-500 hover:bg-slate-50 rounded-lg"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-lg font-bold text-slate-800">人事智能QA系统</h1>
          </div>
        </header>

        <div className="flex-1 p-4 lg:p-8 overflow-hidden">
          <div className="max-w-5xl mx-auto h-full">
            {isLoadingDocs ? (
              <div className="flex items-center justify-center h-full text-slate-500">加载知识库中...</div>
            ) : currentView === 'admin' ? (
              <AdminPanel 
                knowledgeBase={knowledgeBase} 
                onDocsChange={fetchDocs}
              />
            ) : currentView === 'settings' ? (
              <Settings />
            ) : (
              <Chat 
                mode={activeModule.title} 
                modeId={activeModule.id}
                systemPrompt={activeModule.systemPrompt}
                welcomeMessage={activeModule.welcomeMessage}
                knowledgeBase={knowledgeBase}
                threadId={currentThreadId}
                onThreadCreated={(id) => {
                  setCurrentThreadId(id);
                  fetchThreads();
                }}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
