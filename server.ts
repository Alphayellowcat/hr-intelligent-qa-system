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
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || `${7 * 24 * 60 * 60 * 1000}`, 10);
const SSO_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const LOG_API_REQUESTS = process.env.LOG_API_REQUESTS !== 'false';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use((req: any, res: any, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  if (LOG_API_REQUESTS && req.path.startsWith('/api/')) {
    const startAt = Date.now();
    res.on('finish', () => {
      const log = {
        level: 'info',
        type: 'http_access',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startAt,
        userId: req.user?.id ?? null,
        ip: req.ip
      };
      console.log(JSON.stringify(log));
    });
  }
  next();
});

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

function tokenizeQuestion(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 20);
}

function makeQuestionSignature(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
    role TEXT,
    status TEXT DEFAULT 'active',
    display_name TEXT,
    last_login_at DATETIME,
    failed_login_attempts INTEGER DEFAULT 0,
    lock_until DATETIME
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

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id INTEGER,
    action TEXT,
    target_path TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sso_challenges (
    id TEXT PRIMARY KEY,
    provider TEXT,
    status TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS sso_identities (
    id TEXT PRIMARY KEY,
    provider TEXT,
    provider_user_id TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, provider_user_id)
  );

  CREATE TABLE IF NOT EXISTS agent_memories (
    id TEXT PRIMARY KEY,
    owner_user_id INTEGER,
    question_signature TEXT,
    keywords TEXT,
    plan_json TEXT,
    retrieval_summary TEXT,
    success_count INTEGER DEFAULT 0,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 迁移：添加 must_change_password 列（若不存在）
try {
  const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
  }
  if (!cols.some((c) => c.name === 'display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!cols.some((c) => c.name === 'last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at DATETIME');
  }
  if (!cols.some((c) => c.name === 'failed_login_attempts')) {
    db.exec('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'lock_until')) {
    db.exec('ALTER TABLE users ADD COLUMN lock_until DATETIME');
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
  
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Unauthorized' });
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any;
  
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const createdAt = new Date(session.created_at).getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  
  const user = db.prepare('SELECT id, username, role, must_change_password, status, display_name FROM users WHERE id = ?').get(
    session.user_id
  ) as any;
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });
  
  req.user = {
    ...user,
    mustChangePassword: !!user.must_change_password,
    displayName: user.display_name || user.username
  };
  req.token = token;
  next();
};

const requireAdmin = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
};

function logAudit(actorUserId: number, action: string, targetPath: string, detail: string) {
  db.prepare(
    'INSERT INTO audit_logs (id, actor_user_id, action, target_path, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), actorUserId, action, targetPath, detail);
}

function isSafePathSegment(input: string) {
  if (!input || typeof input !== 'string') return false;
  if (input.includes('\0') || input.includes('..') || input.includes('/') || input.includes('\\')) return false;
  return true;
}

function isStrongPassword(password: string): boolean {
  // 至少 10 位，包含大小写字母、数字和特殊字符
  if (typeof password !== 'string' || password.length < 10) return false;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasUpper && hasLower && hasDigit && hasSpecial;
}

function makeSystemPassword() {
  // 生成满足强密码策略的系统随机密码
  return `Aa1!${crypto.randomBytes(16).toString('hex')}`;
}

// --- API Routes ---

// Auth
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });
    if (user.lock_until && new Date(user.lock_until).getTime() > Date.now()) {
      return res.status(423).json({ error: '账号已临时锁定，请稍后再试' });
    }

    const valid =
      user.password.includes(':') ? await verifyPassword(password, user.password) : false;
    if (!valid) {
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      if (attempts >= 5) {
        const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.prepare('UPDATE users SET failed_login_attempts = 0, lock_until = ? WHERE id = ?').run(lockUntil, user.id);
      } else {
        db.prepare('UPDATE users SET failed_login_attempts = ?, lock_until = NULL WHERE id = ?').run(attempts, user.id);
      }
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, failed_login_attempts = 0, lock_until = NULL WHERE id = ?').run(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        role: user.role,
        mustChangePassword: !!user.must_change_password
      }
    });
  } catch (err) {
    res.status(500).json({ error: '登录失败，请稍后再试' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度必须在3到20个字符之间' });
  }
  
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: '密码强度不足：至少10位，且包含大小写字母、数字和特殊字符' });
  }
  
  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  
  try {
    const hashed = await hashPassword(password);
    const result = db
      .prepare('INSERT INTO users (username, password, role, must_change_password, status, display_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hashed, 'employee', 0, 'active', username);
    const userId = result.lastInsertRowid;

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);

    res.json({ token, user: { id: userId, username, displayName: username, role: 'employee', mustChangePassword: false } });
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
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ error: '新密码强度不足：至少10位，且包含大小写字母、数字和特殊字符' });
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

app.get('/api/auth/sso/providers', (req, res) => {
  const googleEnabled = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
  res.json({
    providers: [
      { id: 'google', name: 'Google', enabled: googleEnabled },
      { id: 'wechat', name: '微信', enabled: true },
      { id: 'feishu', name: '飞书', enabled: true }
    ]
  });
});

app.post('/api/auth/sso/challenge', (req, res) => {
  const { provider } = req.body || {};
  if (!['google', 'wechat', 'feishu'].includes(provider)) {
    return res.status(400).json({ error: '不支持的 SSO Provider' });
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SSO_CHALLENGE_TTL_MS).toISOString();
  db.prepare('INSERT INTO sso_challenges (id, provider, status, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, provider, 'pending', expiresAt);
  res.json({
    challengeId: id,
    provider,
    expiresAt,
    qrPayload: `hrqa://sso/${provider}?challenge=${id}`
  });
});

app.post('/api/auth/sso/google/start', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.SSO_REDIRECT_BASE_URL || `${req.protocol}://${req.get('host')}`;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: 'Google SSO 未配置（缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）' });
  }

  const challengeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SSO_CHALLENGE_TTL_MS).toISOString();
  db.prepare('INSERT INTO sso_challenges (id, provider, status, expires_at) VALUES (?, ?, ?, ?)')
    .run(challengeId, 'google', 'pending', expiresAt);

  const redirectUri = `${baseUrl}/api/auth/sso/callback/google`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: challengeId,
    prompt: 'select_account'
  });

  res.json({
    challengeId,
    expiresAt,
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  });
});

app.get('/api/auth/sso/callback/google', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code || !state) return res.status(400).send('Missing code/state');

  const challenge = db.prepare('SELECT * FROM sso_challenges WHERE id = ?').get(state) as any;
  if (!challenge || challenge.provider !== 'google') return res.status(400).send('Invalid challenge');
  if (challenge.status !== 'pending') return res.status(400).send('Challenge already used/expired');
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE sso_challenges SET status = ? WHERE id = ?').run('expired', state);
    return res.status(400).send('Challenge expired');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.SSO_REDIRECT_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/api/auth/sso/callback/google`;
  if (!clientId || !clientSecret) return res.status(503).send('Google SSO is not configured');

  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!tokenResp.ok) return res.status(502).send('Google token exchange failed');
    const tokenData = await tokenResp.json() as any;
    if (!tokenData.access_token) return res.status(502).send('Missing Google access token');

    const userResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userResp.ok) return res.status(502).send('Google userinfo request failed');
    const profile = await userResp.json() as any;
    const providerUserId = String(profile.sub || '');
    if (!providerUserId) return res.status(502).send('Google profile missing subject');

    let userId: number | null = null;
    const existingIdentity = db.prepare(
      'SELECT user_id FROM sso_identities WHERE provider = ? AND provider_user_id = ?'
    ).get('google', providerUserId) as any;
    if (existingIdentity?.user_id) {
      userId = Number(existingIdentity.user_id);
    } else {
      const preferredUsername = String(profile.email || `google_${providerUserId}`);
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(preferredUsername) as any;
      if (existingUser?.id) {
        userId = Number(existingUser.id);
      } else {
        const randomPw = makeSystemPassword();
        const hashed = await hashPassword(randomPw);
        const created = db.prepare(
          'INSERT INTO users (username, password, role, must_change_password, status, display_name) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(preferredUsername, hashed, 'employee', 0, 'active', profile.name || preferredUsername);
        userId = Number(created.lastInsertRowid);
      }
      db.prepare(
        'INSERT OR IGNORE INTO sso_identities (id, provider, provider_user_id, user_id) VALUES (?, ?, ?, ?)'
      ).run(crypto.randomUUID(), 'google', providerUserId, userId);
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(500).send('User binding failed');
    db.prepare('UPDATE sso_challenges SET status = ?, username = ? WHERE id = ?').run('approved', user.username, state);
    return res.type('html').send(`
      <html><body style="font-family: sans-serif; padding: 24px;">
      <h3>Google 登录成功</h3>
      <p>你可以返回登录页，系统会自动完成登录。</p>
      <script>setTimeout(function(){ window.close(); }, 1200)</script>
      </body></html>
    `);
  } catch (err) {
    db.prepare('UPDATE sso_challenges SET status = ? WHERE id = ?').run('expired', state);
    return res.status(500).send('Google SSO callback failed');
  }
});

app.get('/api/auth/sso/challenge/:id', (req, res) => {
  const row = db
    .prepare('SELECT id, provider, status, username, expires_at FROM sso_challenges WHERE id = ?')
    .get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: '挑战不存在' });
  if (new Date(row.expires_at).getTime() < Date.now() && row.status === 'pending') {
    db.prepare('UPDATE sso_challenges SET status = ? WHERE id = ?').run('expired', row.id);
    row.status = 'expired';
  }
  if (row.status !== 'approved') {
    return res.json({ status: row.status, provider: row.provider, username: row.username || null });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(row.username) as any;
  if (!user || user.status === 'disabled') {
    return res.status(403).json({ error: 'SSO 用户不可用' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  db.prepare('UPDATE sso_challenges SET status = ? WHERE id = ?').run('completed', row.id);
  return res.json({
    status: 'approved',
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role,
      mustChangePassword: !!user.must_change_password
    }
  });
});

// Demo 模拟扫码回调（生产环境请替换为微信/飞书官方回调）
app.post('/api/auth/sso/mock/complete', (req, res) => {
  const { challengeId, username } = req.body || {};
  if (!challengeId || !username) return res.status(400).json({ error: '参数不完整' });
  const challenge = db.prepare('SELECT * FROM sso_challenges WHERE id = ?').get(challengeId) as any;
  if (!challenge) return res.status(404).json({ error: '挑战不存在' });
  if (challenge.status !== 'pending') return res.status(400).json({ error: '挑战状态不可用' });

  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user) {
    const randomPw = crypto.randomBytes(12).toString('hex');
    hashPassword(randomPw).then((hashed) => {
      db.prepare('INSERT INTO users (username, password, role, must_change_password, status, display_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, hashed, 'employee', 0, 'active', username);
      db.prepare('UPDATE sso_challenges SET status = ?, username = ? WHERE id = ?').run('approved', username, challengeId);
      res.json({ success: true, username });
    }).catch(() => res.status(500).json({ error: '创建用户失败' }));
    return;
  }
  db.prepare('UPDATE sso_challenges SET status = ?, username = ? WHERE id = ?').run('approved', username, challengeId);
  return res.json({ success: true, username: user.username });
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

app.post('/api/settings', authMiddleware, requireAdmin, (req: any, res) => {
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

app.post('/api/models', authMiddleware, requireAdmin, async (req: any, res) => {
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

// Admin - User management
app.get('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, role, status, display_name, must_change_password, last_login_at FROM users ORDER BY id ASC'
  ).all();
  res.json(users);
});

app.post('/api/admin/users', authMiddleware, requireAdmin, async (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: '用户名长度必须在3到20个字符之间' });
  if (!['admin', 'employee'].includes(role)) return res.status(400).json({ error: '角色不合法' });
  if (!isStrongPassword(password)) return res.status(400).json({ error: '初始密码强度不足' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已存在' });
  const hashed = await hashPassword(password);
  const result = db.prepare(
    'INSERT INTO users (username, password, role, status, display_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, hashed, role, 'active', displayName || username, 1);
  logAudit((req as any).user.id, 'user.create', `/users/${username}`, `role=${role}`);
  res.json({ id: result.lastInsertRowid });
});

app.patch('/api/admin/users/:id', authMiddleware, requireAdmin, async (req: any, res) => {
  const { id } = req.params;
  const { role, status, resetPassword, displayName } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (role && !['admin', 'employee'].includes(role)) return res.status(400).json({ error: '角色不合法' });
  if (status && !['active', 'disabled'].includes(status)) return res.status(400).json({ error: '状态不合法' });

  const nextRole = role || user.role;
  const nextStatus = status || user.status;
  const adminCountRow = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND status = 'active'").get() as { cnt: number };
  const isLastActiveAdmin = user.role === 'admin' && user.status === 'active' && Number(adminCountRow?.cnt || 0) <= 1;
  if (isLastActiveAdmin && (nextRole !== 'admin' || nextStatus !== 'active')) {
    return res.status(400).json({ error: '系统至少需要保留一个启用状态的管理员账号' });
  }

  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (status) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  if (typeof displayName === 'string') db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName.trim() || user.username, id);
  if (resetPassword) {
    if (!isStrongPassword(resetPassword)) {
      return res.status(400).json({ error: '重置密码强度不足' });
    }
    const hashed = await hashPassword(resetPassword);
    db.prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?').run(hashed, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  logAudit(req.user.id, 'user.update', `/users/${user.username}`, JSON.stringify({ role, status, resetPassword: !!resetPassword, displayName }));
  res.json({ success: true });
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

// Agent memory for self-learning retrieval patterns
app.post('/api/agent-memory/suggest', authMiddleware, (req: any, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'Missing question' });
    const tokens = tokenizeQuestion(question);
    if (tokens.length === 0) return res.json({ items: [] });

    const rows = db.prepare(
      `SELECT * FROM agent_memories
       WHERE owner_user_id = ?
       ORDER BY success_count DESC, updated_at DESC
       LIMIT 40`
    ).all(req.user.id) as any[];

    const scored = rows
      .map((row) => {
        const memoryTokens: string[] = parseJsonSafe<string[]>(row.keywords, []);
        const overlap = tokens.filter((t) => memoryTokens.includes(t)).length;
        return {
          id: row.id,
          score: overlap + Math.min(Number(row.success_count || 0), 5) * 0.2,
          overlap,
          successCount: row.success_count || 0,
          signature: row.question_signature,
          retrievalSummary: row.retrieval_summary,
          plan: parseJsonSafe<any>(row.plan_json, null)
        };
      })
      .filter((item) => item.overlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    res.json({ items: scored });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent-memory/record', authMiddleware, (req: any, res) => {
  try {
    const { question, plan, retrievalSummary, success } = req.body || {};
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'Missing question' });
    if (!success) return res.json({ success: true, skipped: true });

    const signature = makeQuestionSignature(question);
    const keywords = tokenizeQuestion(question);
    if (keywords.length === 0) return res.json({ success: true, skipped: true });

    const existing = db.prepare(
      'SELECT id FROM agent_memories WHERE owner_user_id = ? AND question_signature = ?'
    ).get(req.user.id, signature) as any;

    if (existing?.id) {
      db.prepare(
        `UPDATE agent_memories
         SET keywords = ?, plan_json = ?, retrieval_summary = ?,
             success_count = success_count + 1,
             last_used_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(
        JSON.stringify(keywords),
        plan ? JSON.stringify(plan) : null,
        retrievalSummary || null,
        existing.id
      );
      return res.json({ success: true, id: existing.id, updated: true });
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_memories
       (id, owner_user_id, question_signature, keywords, plan_json, retrieval_summary, success_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      req.user.id,
      signature,
      JSON.stringify(keywords),
      plan ? JSON.stringify(plan) : null,
      retrievalSummary || null
    );
    res.json({ success: true, id, created: true });
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
  if (!['user', 'assistant'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > 20000) {
    return res.status(400).json({ error: 'Invalid content' });
  }
  
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
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden: Admins only' });

  try {
    const { folder, filename, content } = req.body;
    if (!folder || !filename || content === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!isSafePathSegment(folder) || !isSafePathSegment(filename) || !filename.endsWith('.md')) {
      return res.status(400).json({ error: 'Illegal folder or filename' });
    }

    const folderPath = path.join(KNOWLEDGE_DIR, folder);
    await fs.mkdir(folderPath, { recursive: true });
    
    const filePath = path.join(folderPath, filename);
    let previous = '';
    try {
      previous = await fs.readFile(filePath, 'utf-8');
    } catch {}
    await fs.writeFile(filePath, content, 'utf-8');
    const action = previous ? 'doc.update' : 'doc.create';
    logAudit(req.user.id, action, `/${folder}/${filename}`, JSON.stringify({
      previousLength: previous.length,
      newLength: typeof content === 'string' ? content.length : 0
    }));
    
    res.json({ success: true });
    triggerKnowledgeIndex();
  } catch (error) {
    console.error('Error saving doc:', error);
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/docs/audit', authMiddleware, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const rows = db.prepare(`
    SELECT a.id, a.action, a.target_path, a.detail, a.created_at, u.username AS actor
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
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

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/readyz', async (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const indexStatus = await vectorStore.getIndexStatus();
    res.json({
      status: 'ready',
      checks: {
        db: 'ok',
        vectorIndex: indexStatus?.tableExists && indexStatus.chunkCount > 0 ? 'ok' : 'degraded'
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'not-ready',
      checks: { db: 'error' }
    });
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
  setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE datetime(created_at) <= datetime('now', ?)").run(`-${Math.floor(SESSION_TTL_MS / 1000)} seconds`);
    db.prepare("DELETE FROM sso_challenges WHERE datetime(expires_at) <= datetime('now')").run();
  }, 10 * 60 * 1000).unref();
  await startServer();
}
init();
