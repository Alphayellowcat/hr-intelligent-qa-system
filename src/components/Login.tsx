import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, setToken } from '../api';
import { User, Lock, Loader2, QrCode, ShieldCheck, Smartphone } from 'lucide-react';

interface LoginProps {
  onLogin: (user: any) => void;
}

type SsoProvider = 'wechat' | 'feishu';
type SsoStatus = 'idle' | 'pending' | 'approved' | 'expired' | 'completed';

const PROVIDER_LABEL: Record<SsoProvider, string> = {
  wechat: '微信',
  feishu: '飞书'
};

export function Login({ onLogin }: LoginProps) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [loginMode, setLoginMode] = useState<'password' | 'sso'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [ssoProvider, setSsoProvider] = useState<SsoProvider>('wechat');
  const [challengeId, setChallengeId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [scanUser, setScanUser] = useState('');
  const [ssoStatus, setSsoStatus] = useState<SsoStatus>('idle');

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const statusLabel = useMemo(() => {
    if (ssoStatus === 'pending') return '等待扫码';
    if (ssoStatus === 'approved') return '已授权，准备登录';
    if (ssoStatus === 'completed') return '登录完成';
    if (ssoStatus === 'expired') return '二维码过期';
    return '未开始';
  }, [ssoStatus]);

  useEffect(() => {
    if (loginMode !== 'sso' || !challengeId || ssoStatus !== 'pending') return;
    const timer = setInterval(() => {
      pollSsoStatus();
    }, 2500);
    return () => clearInterval(timer);
  }, [loginMode, challengeId, ssoStatus]);

  const resetFeedback = () => {
    setError('');
    setSuccess('');
  };

  const resetSso = () => {
    setChallengeId('');
    setExpiresAt('');
    setScanUser('');
    setSsoStatus('idle');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();

    if (isRegistering) {
      if (password !== confirmPassword) return setError('两次输入的密码不一致');
      if (!/^[a-zA-Z0-9_]+$/.test(username)) return setError('用户名只能包含字母、数字和下划线');
      if (username.length < 3 || username.length > 20) return setError('用户名长度必须在3到20个字符之间');
      if (password.length < 6) return setError('密码长度至少为6个字符');
    }

    setIsLoading(true);
    try {
      const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
      const data = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setToken(data.token);
      onLogin(data.user);
    } catch (err: any) {
      setError(err.message || (isRegistering ? '注册失败' : '登录失败'));
    } finally {
      setIsLoading(false);
    }
  };

  const createChallenge = async (provider: SsoProvider) => {
    resetFeedback();
    setIsLoading(true);
    try {
      const data = await apiFetch('/api/auth/sso/challenge', {
        method: 'POST',
        body: JSON.stringify({ provider })
      });
      setSsoProvider(provider);
      setChallengeId(data.challengeId);
      setExpiresAt(data.expiresAt);
      setSsoStatus('pending');
      setSuccess(`已生成 ${PROVIDER_LABEL[provider]} 扫码授权二维码，请在 2 分钟内完成扫码。`);
    } catch (err: any) {
      setError(err.message || '获取二维码失败');
    } finally {
      setIsLoading(false);
    }
  };

  const pollSsoStatus = async () => {
    if (!challengeId) return;
    try {
      const data = await apiFetch(`/api/auth/sso/challenge/${challengeId}`);
      if (data.status === 'approved' && data.token) {
        setToken(data.token);
        onLogin(data.user);
        return;
      }
      setSsoStatus(data.status);
    } catch (err: any) {
      setError(err.message || 'SSO 状态检查失败');
    }
  };

  const simulateScan = async () => {
    if (!challengeId || !scanUser.trim()) return;
    setIsLoading(true);
    resetFeedback();
    try {
      await apiFetch('/api/auth/sso/mock/complete', {
        method: 'POST',
        body: JSON.stringify({ challengeId, username: scanUser.trim() })
      });
      setSuccess('模拟扫码已提交，正在完成登录...');
      await pollSsoStatus();
    } catch (err: any) {
      setError(err.message || '模拟扫码失败');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50/40 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-5xl grid lg:grid-cols-[1.15fr,1fr] gap-6">
        <section className="hidden lg:flex rounded-3xl p-8 bg-indigo-600 text-white flex-col justify-between shadow-xl">
          <div>
            <p className="text-indigo-200 text-sm tracking-wider uppercase">HR Intelligent Assistant</p>
            <h1 className="text-3xl font-bold mt-3 leading-tight">把 HR 咨询、制度维护、权限治理，
              <br />统一在一个工作台。</h1>
            <p className="text-indigo-100/90 mt-4 text-sm leading-6">支持多用户并发访问、角色控制、文档审计与 Agent 化知识问答，适合从玩具项目向产品化迭代。</p>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2"><ShieldCheck size={16} /> 统一认证与权限</div>
            <div className="flex items-center gap-2"><QrCode size={16} /> 支持扫码登录扩展</div>
            <div className="flex items-center gap-2"><Smartphone size={16} /> 移动端可用交互</div>
          </div>
        </section>

        <section className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-slate-900">人事智能 QA 系统</h2>
            <p className="text-slate-500 mt-2 text-sm">{isRegistering ? '注册新账号' : '登录继续使用系统'}</p>
          </div>

          {!isRegistering && (
            <div className="grid grid-cols-2 bg-slate-100 p-1 rounded-xl mb-5">
              <button type="button" onClick={() => { setLoginMode('password'); resetSso(); }} className={`py-2 text-sm rounded-lg transition ${loginMode === 'password' ? 'bg-white shadow text-indigo-700' : 'text-slate-500'}`}>密码登录</button>
              <button type="button" onClick={() => setLoginMode('sso')} className={`py-2 text-sm rounded-lg transition ${loginMode === 'sso' ? 'bg-white shadow text-indigo-700' : 'text-slate-500'}`}>微信/飞书扫码</button>
            </div>
          )}

          {error && <div className="p-3 mb-4 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100">{error}</div>}
          {success && <div className="p-3 mb-4 bg-emerald-50 text-emerald-700 text-sm rounded-lg border border-emerald-100">{success}</div>}

          {loginMode === 'password' || isRegistering ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">用户名</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                  <input type="text" required value={username} onChange={(e) => setUsername(e.target.value)} className="w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="输入用户名" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                  <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="输入密码" />
                </div>
              </div>

              {isRegistering && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">确认密码</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                    <input type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="再次输入密码" />
                  </div>
                </div>
              )}

              <button type="submit" disabled={isLoading} className="w-full flex justify-center py-2.5 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50">
                {isLoading ? <Loader2 className="animate-spin h-5 w-5" /> : (isRegistering ? '注册' : '登录')}
              </button>

              <div className="text-center mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsRegistering(!isRegistering);
                    resetFeedback();
                    setUsername('');
                    setPassword('');
                    setConfirmPassword('');
                  }}
                  className="text-sm text-indigo-600 hover:text-indigo-500 font-medium"
                >
                  {isRegistering ? '已有账号？去登录' : '没有账号？去注册'}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PROVIDER_LABEL) as SsoProvider[]).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => createChallenge(provider)}
                    className={`py-2 rounded-lg border text-sm ${ssoProvider === provider ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}
                  >
                    {PROVIDER_LABEL[provider]}授权
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">二维码授权状态</p>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-white border text-slate-600">{statusLabel}</span>
                </div>
                <p className="text-xs text-slate-500 mt-2">Provider：{PROVIDER_LABEL[ssoProvider]} · 挑战ID：{challengeId ? `${challengeId.slice(0, 8)}...` : '未生成'}</p>
                {expiresAt && <p className="text-xs text-slate-500 mt-1">有效期至：{new Date(expiresAt).toLocaleString()}</p>}
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => pollSsoStatus()} className="flex-1 text-sm py-2 rounded-lg border border-slate-300 text-slate-700">刷新状态</button>
                  <button type="button" onClick={() => createChallenge(ssoProvider)} className="flex-1 text-sm py-2 rounded-lg bg-indigo-600 text-white" disabled={isLoading}>{isLoading ? '生成中...' : '重新生成'}</button>
                </div>
              </div>

              <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3">
                <p className="text-xs text-amber-700">Demo 联调模式：输入用户名模拟扫码回调（生产环境接入企业微信/飞书 OAuth 回调）。</p>
                <div className="mt-2 flex gap-2">
                  <input value={scanUser} onChange={(e) => setScanUser(e.target.value)} placeholder="模拟扫码用户名" className="flex-1 px-3 py-2 border border-amber-200 rounded-lg text-sm" />
                  <button type="button" onClick={simulateScan} className="px-3 py-2 text-sm rounded-lg bg-amber-600 text-white disabled:opacity-50" disabled={isLoading || !scanUser || !challengeId}>模拟扫码</button>
                </div>
              </div>
            </div>
          )}

          <p className="text-xs text-center text-slate-400 mt-5">默认账号：admin / admin123 ，employee / emp123</p>
        </section>
      </div>
    </div>
  );
}
