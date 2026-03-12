import React, { useState } from 'react';
import { apiFetch, setToken } from '../api';
import { User, Lock, Loader2 } from 'lucide-react';

interface LoginProps {
  onLogin: (user: any) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (isRegistering) {
      if (password !== confirmPassword) {
        setError('两次输入的密码不一致');
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        setError('用户名只能包含字母、数字和下划线');
        return;
      }
      if (username.length < 3 || username.length > 20) {
        setError('用户名长度必须在3到20个字符之间');
        return;
      }
      if (password.length < 6) {
        setError('密码长度至少为6个字符');
        return;
      }
    }

    setIsLoading(true);

    try {
      const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
      const data = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      onLogin(data.user);
    } catch (err: any) {
      setError(err.message || (isRegistering ? '注册失败' : '登录失败'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-indigo-900">人事智能QA系统</h1>
          <p className="text-slate-500 mt-2 text-sm">
            {isRegistering ? '注册新账号' : '请登录以继续 (默认账号: admin/admin123 或 employee/emp123)'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100">
              {error}
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">用户名</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-colors"
                placeholder="输入用户名"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">密码</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-colors"
                placeholder="输入密码"
              />
            </div>
          </div>

          {isRegistering && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">确认密码</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-colors"
                  placeholder="再次输入密码"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? <Loader2 className="animate-spin h-5 w-5" /> : (isRegistering ? '注册' : '登录')}
          </button>
          
          <div className="text-center mt-4">
            <button
              type="button"
              onClick={() => {
                setIsRegistering(!isRegistering);
                setError('');
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
      </div>
    </div>
  );
}
