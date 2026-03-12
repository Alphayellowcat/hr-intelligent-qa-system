/// <reference types="node" />
import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import * as vectorStore from './src/server/vectorStore';
import { queueEmbedding, queueChat } from './src/server/apiQueue';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Increase payload limit for large markdown files
app.use(express.json({ limit: '50mb' }));

// --- 限流 ---
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', generalLimiter);

const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'LLM 请求过于频繁，请稍后再试' },
  standardHeaders: true
});
app.use('/api/openai/v1/chat/completions', llmLimiter);

const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: '检索请求过于频繁，请稍后再试' },
  standardHeaders: true
});
app.use('/api/semantic-search', embedLimiter);
app.use('/api/openai/v1/embeddings', embedLimiter);

const KNOWLEDGE_DIR = path.join(process.cwd(), 'knowledge');

// --- 密码哈希工具（使用 Node 内置 crypto.scrypt）---
function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}
function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else {
        try {
          resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey));
        } catch {
          resolve(false);
        }
      }
    });
  });
}

// --- Database Setup ---
const db = new Database('app.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );
  
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    mode_id TEXT,
    title TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    role TEXT,
    content TEXT,
    refs TEXT,
    agent_logs TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 迁移：添加 must_change_password 列（若不存在）
try {
  const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  }
} catch (_) {}

// Seed default users（异步，需在 initDb 中调用）
async function seedUsers() {
  const adminPw = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  const empPw = 'emp123';
  const adminHash = await hashPassword(adminPw);
  const empHash = await hashPassword(empPw);

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, ?)'
  );
  insertUser.run('admin', adminHash, 'admin', 1);
  insertUser.run('employee', empHash, 'employee', 0);

  // 迁移：对已有明文密码进行哈希
  const users = db.prepare('SELECT id, username, password FROM users').all() as {
    id: number;
    username: string;
    password: string;
  }[];
  for (const u of users) {
    if (!u.password.includes(':')) {
      const hash = await hashPassword(u.password);
      const mustChange = u.username === 'admin' ? 1 : 0;
      db.prepare('UPDATE users SET password = ?, must_change_password = ? WHERE id = ?').run(
        hash,
        mustChange,
        u.id
      );
    }
  }
}

// Seed default settings (no real API key - configure in Settings UI)
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('api_url', process.env.API_INITIAL_URL || 'https://api.siliconflow.cn/v1');
insertSetting.run('api_key', process.env.API_INITIAL_KEY || '');
insertSetting.run('llm_model', 'deepseek-ai/DeepSeek-V3');
insertSetting.run('embedding_model', 'BAAI/bge-m3');

// --- Auth Middleware ---
const authMiddleware = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  
  const token = authHeader.split(' ')[1];
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any;
  
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  
  const user = db.prepare('SELECT id, username, role, must_change_password FROM users WHERE id = ?').get(
    session.user_id
  ) as any;
  if (!user) return res.status(401).json({ error: 'User not found' });
  
  req.user = {
    ...user,
    mustChangePassword: !!user.must_change_password
  };
  req.token = token;
  next();
};

// --- API Routes ---

// Auth
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });

    const valid =
      user.password.includes(':') ? await verifyPassword(password, user.password) : false;
    if (!valid) return res.status(401).json({ error: '用户名或密码错误' });

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: !!user.must_change_password
      }
    });
  } catch (err) {
    res.status(500).json({ error: '登录失败，请稍后再试' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度必须在3到20个字符之间' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: '密码长度至少为6个字符' });
  }
  
  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  
  try {
    const hashed = await hashPassword(password);
    const result = db
      .prepare('INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, ?)')
      .run(username, hashed, 'employee', 0);
    const userId = result.lastInsertRowid;

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);

    res.json({ token, user: { id: userId, username, role: 'employee', mustChangePassword: false } });
  } catch (err) {
    res.status(500).json({ error: '注册失败，请稍后再试' });
  }
});

app.post('/api/auth/logout', authMiddleware, (req: any, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ success: true });
});

app.post('/api/auth/change-password', authMiddleware, async (req: any, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '当前密码和新密码不能为空' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少为6个字符' });
    }

    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id) as any;
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const valid =
      user.password.includes(':') ? await verifyPassword(currentPassword, user.password) : false;
    if (!valid) return res.status(401).json({ error: '当前密码错误' });

    const hashed = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(
      hashed,
      req.user.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '修改密码失败，请稍后再试' });
  }
});

app.get('/api/auth/me', authMiddleware, (req: any, res) => {
  res.json({ user: req.user });
});

// Settings
app.get('/api/settings', authMiddleware, (req: any, res) => {
  const rows = db.prepare('SELECT * FROM settings').all() as any[];
  const settings = rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
  
  // Only admin can see the full API key, others get a masked version or nothing
  if (req.user.role !== 'admin' && settings.api_key) {
    settings.api_key = '********';
  }
  
  res.json(settings);
});

app.post('/api/settings', authMiddleware, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  
  const updates = req.body;
  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  
  db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      const result = stmt.run(value, key);
      if (result.changes === 0) {
        insertStmt.run(key, value);
      }
    }
  })();
  
  res.json({ success: true });
});

app.post('/api/models', authMiddleware, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  
  const { api_url, api_key } = req.body;
  try {
    const response = await fetch(`${api_url}/models`, {
      headers: { 'Authorization': `Bearer ${api_key}` }
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// OpenAI Proxy（经队列限流，避免外部 API 429）
app.post('/api/openai/v1/chat/completions', authMiddleware, async (req: any, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {} as any);
    const body = { ...req.body, model: settings.llm_model };
    const response = await queueChat(() =>
      fetch(`${settings.api_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    );
    if (!response.ok) return res.status(response.status).send(await response.text());
    res.json(await response.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/openai/v1/embeddings', authMiddleware, async (req: any, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {} as any);
    const body = { ...req.body, model: settings.embedding_model };
    const response = await queueEmbedding(() =>
      fetch(`${settings.api_url}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    );
    if (!response.ok) return res.status(response.status).send(await response.text());
    res.json(await response.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Chat Threads
app.get('/api/chat/threads', authMiddleware, (req: any, res) => {
  const threads = db.prepare('SELECT * FROM chat_threads WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  res.json(threads);
});

app.post('/api/chat/threads', authMiddleware, (req: any, res) => {
  const { mode_id, title } = req.body;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO chat_threads (id, user_id, mode_id, title) VALUES (?, ?, ?, ?)').run(id, req.user.id, mode_id, title);
  res.json({ id, mode_id, title });
});

app.delete('/api/chat/threads/:id', authMiddleware, (req: any, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM chat_threads WHERE id = ? AND user_id = ?').run(id, req.user.id);
  db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(id);
  res.json({ success: true });
});

// Chat Messages
app.get('/api/chat/threads/:id/messages', authMiddleware, (req: any, res) => {
  const { id } = req.params;
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  
  const messages = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC').all(id);
  res.json(messages.map((m: any) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    references: m.refs ? JSON.parse(m.refs) : undefined,
    agentLogs: m.agent_logs ? JSON.parse(m.agent_logs) : undefined
  })));
});

app.post('/api/chat/threads/:id/messages', authMiddleware, (req: any, res) => {
  const { id } = req.params;
  const { role, content, references, agentLogs } = req.body;
  
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  
  const msgId = crypto.randomUUID();
  db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, refs, agent_logs) VALUES (?, ?, ?, ?, ?, ?)')
    .run(msgId, id, role, content, references ? JSON.stringify(references) : null, agentLogs ? JSON.stringify(agentLogs) : null);
    
  db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  
  res.json({ success: true, id: msgId });
});

// Helper to read directory recursively
async function getDocsTree() {
  const tree: any[] = [];
  try {
    await fs.access(KNOWLEDGE_DIR);
  } catch {
    await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
  }
  
  const folders = await fs.readdir(KNOWLEDGE_DIR, { withFileTypes: true });
  for (const folder of folders) {
    if (folder.isDirectory()) {
      const folderPath = path.join(KNOWLEDGE_DIR, folder.name);
      const files = await fs.readdir(folderPath, { withFileTypes: true });
      const fileNodes: any[] = [];
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.md')) {
          const content = await fs.readFile(path.join(folderPath, file.name), 'utf-8');
          fileNodes.push({
            key: `${folder.name}/${file.name}`,
            name: file.name,
            content
          });
        }
      }
      if (fileNodes.length > 0) {
        tree.push({
          folder: folder.name,
          files: fileNodes
        });
      }
    }
  }
  return tree;
}

// Docs Routes
app.get('/api/docs', authMiddleware, async (req, res) => {
  try {
    const tree = await getDocsTree();
    res.json(tree);
  } catch (error) {
    console.error('Error reading docs:', error);
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/docs', authMiddleware, async (req: any, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admins only' });
  }

  try {
    const { folder, filename, content } = req.body;
    if (!folder || !filename || content === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const folderPath = path.join(KNOWLEDGE_DIR, folder);
    await fs.mkdir(folderPath, { recursive: true });
    
    const filePath = path.join(folderPath, filename);
    await fs.writeFile(filePath, content, 'utf-8');
    
    res.json({ success: true });
    triggerKnowledgeIndex();
  } catch (error) {
    console.error('Error saving doc:', error);
    res.status(500).json({ error: String(error) });
  }
});

// --- 向量索引 API ---
const INDEX_LOCK_FILE = path.join(process.cwd(), '.lancedb', '.indexing');
let indexPromise: Promise<void> | null = null;

async function acquireIndexLock(): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(INDEX_LOCK_FILE), { recursive: true });
    const fd = await fs.open(INDEX_LOCK_FILE, 'wx');
    await fd.close();
    return true;
  } catch (e: any) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
async function releaseIndexLock(): Promise<void> {
  try { await fs.unlink(INDEX_LOCK_FILE); } catch { /* ignore */ }
}

async function runKnowledgeIndex(): Promise<void> {
  if (!(await acquireIndexLock())) {
    console.warn('[VectorIndex] 其他进程正在索引，跳过');
    return;
  }
  try {
    const rows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings = rows.reduce((acc: any, row: any) => ({ ...acc, [row.key]: row.value }), {});
    if (!settings.api_url || !settings.api_key) {
      console.warn('[VectorIndex] 未配置 API，跳过索引');
      return;
    }
    const tree = await getDocsTree();
    const embedFn = async (texts: string[]) => {
      const resp = await queueEmbedding(() =>
        fetch(`${settings.api_url}/embeddings`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${settings.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: texts, model: settings.embedding_model })
        })
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      return (data.data || []).map((d: any) => d.embedding).filter(Boolean);
    };
    const result = await vectorStore.indexKnowledge(tree, {
      embedFn,
      onProgress: (msg) => console.log('[VectorIndex]', msg)
    });
    console.log('[VectorIndex] 完成:', result);
  } finally {
    await releaseIndexLock();
  }
}

function triggerKnowledgeIndex(): void {
  if (indexPromise) return;
  indexPromise = runKnowledgeIndex().finally(() => { indexPromise = null; });
}

app.get('/api/index/status', authMiddleware, async (req, res) => {
  try {
    const status = await vectorStore.getIndexStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/index', authMiddleware, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  triggerKnowledgeIndex();
  res.json({ success: true, message: '索引任务已启动（增量）' });
});

app.post('/api/semantic-search', authMiddleware, async (req: any, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Missing query' });
    const rows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings = rows.reduce((acc: any, row: any) => ({ ...acc, [row.key]: row.value }), {});
    if (!settings.api_url || !settings.api_key) return res.status(503).json({ error: 'API 未配置' });
    const resp = await queueEmbedding(() =>
      fetch(`${settings.api_url}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: [query], model: settings.embedding_model })
      })
    );
    if (!resp.ok) return res.status(502).json({ error: 'Embedding API 错误' });
    const data = await resp.json();
    const vec = data.data?.[0]?.embedding;
    if (!vec) return res.status(502).json({ error: 'Embedding 生成失败' });
    const matches = await vectorStore.vectorSearch(vec, 5);
    res.json({ matches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  return new Promise<void>((resolve) => {
    app.listen(PORT, '0.0.0.0', () => {
      const w = process.env.WORKER_ID ? ` [worker ${process.env.WORKER_ID}]` : '';
      console.log(`Server running on http://localhost:${PORT}${w}`);
      resolve();
    });
  });
}

async function init() {
  await seedUsers();
  await startServer();
}
init();
