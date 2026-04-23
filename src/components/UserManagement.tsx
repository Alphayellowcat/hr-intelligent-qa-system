import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';
import { Loader2, Users, UserPlus, RefreshCcw, Search, KeyRound } from 'lucide-react';

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'employee';
  status: 'active' | 'disabled';
  display_name?: string;
  last_login_at?: string;
  must_change_password?: number;
}

export function UserManagement() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ username: '', password: '', role: 'employee', displayName: '' });

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/admin/users');
      setUsers(data);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '加载用户失败' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const lower = query.trim().toLowerCase();
    if (!lower) return users;
    return users.filter((u) => (u.username + (u.display_name || '')).toLowerCase().includes(lower));
  }, [users, query]);

  const createUser = async () => {
    if (!form.username || !form.password) {
      setMessage({ type: 'error', text: '用户名和初始密码不能为空' });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(form)
      });
      setMessage({ type: 'success', text: `已创建用户 ${form.username}` });
      setForm({ username: '', password: '', role: 'employee', displayName: '' });
      await loadUsers();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '创建失败' });
    } finally {
      setSubmitting(false);
    }
  };

  const updateUser = async (id: number, patch: Partial<UserRow> & { resetPassword?: string }) => {
    setMessage(null);
    try {
      await apiFetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      setMessage({ type: 'success', text: '更新成功' });
      await loadUsers();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '更新失败' });
    }
  };

  return (
    <div className="h-full bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-slate-800">用户与权限管理</h2>
        </div>
        <button onClick={loadUsers} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-white inline-flex items-center gap-1.5">
          <RefreshCcw className="w-4 h-4" /> 刷新
        </button>
      </div>

      <div className="p-4 border-b border-slate-100 bg-white space-y-3">
        {message && (
          <div className={`text-sm px-3 py-2 rounded-lg border ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
            {message.text}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="用户名" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="显示名" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
          <input className="border rounded-lg px-3 py-2 text-sm" type="password" placeholder="初始密码" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          <select className="border rounded-lg px-3 py-2 text-sm" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="employee">员工</option>
            <option value="admin">管理员</option>
          </select>
          <button disabled={submitting} onClick={createUser} className="bg-indigo-600 text-white rounded-lg text-sm px-3 py-2 inline-flex items-center justify-center gap-1 disabled:opacity-60">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}新增用户
          </button>
        </div>

        <div className="relative max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="按用户名或显示名搜索" />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-slate-500 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />加载中...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b">
                <th className="py-2">用户</th>
                <th>角色</th>
                <th>状态</th>
                <th>最近登录</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className="border-b border-slate-100">
                  <td className="py-2">
                    <div className="font-medium text-slate-800">{u.display_name || u.username}</div>
                    <div className="text-xs text-slate-400">@{u.username}</div>
                  </td>
                  <td>
                    <select className="border rounded px-2 py-1" value={u.role} onChange={(e) => updateUser(u.id, { role: e.target.value as 'admin' | 'employee' })}>
                      <option value="employee">员工</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td>
                    <select className="border rounded px-2 py-1" value={u.status} onChange={(e) => updateUser(u.id, { status: e.target.value as 'active' | 'disabled' })}>
                      <option value="active">启用</option>
                      <option value="disabled">停用</option>
                    </select>
                  </td>
                  <td className="text-slate-500">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '-'}</td>
                  <td className="text-right">
                    <button
                      className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1"
                      onClick={() => {
                        if (!window.confirm(`确认重置 ${u.username} 的密码为 ChangeMe123! ?`)) return;
                        updateUser(u.id, { resetPassword: 'ChangeMe123!' });
                      }}
                    >
                      <KeyRound className="w-3.5 h-3.5" />重置密码
                    </button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">没有匹配的用户</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
