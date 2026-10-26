require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
const usePg = Boolean(process.env.DATABASE_URL);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
app.disable('x-powered-by');
app.set('trust proxy', isProd ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb' }));

let sqlite, pool;
if (usePg) pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : (process.env.PGSSL ? { rejectUnauthorized: false } : undefined) });
else sqlite = new Database(path.join(dataDir, 'hologram.sqlite'));
const query = async (sql, params = []) => {
  if (usePg) {
    const converted = sql.replace(/\?/g, () => '$' + (query.n = (query.n || 0) + 1));
    query.n = 0;
    const r = await pool.query(converted, params);
    return { rows: r.rows, changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
  }
  const s = sqlite.prepare(sql);
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { rows: s.all(...params), changes: 0 };
  const r = s.run(...params);
  return { rows: [], changes: r.changes, lastInsertRowid: r.lastInsertRowid };
};
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
async function init() {
  const statements = [
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'member\', mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT, parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, parent_message_id TEXT, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS model_configs (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL)'
  ];
  for (let sql of statements) {
    if (usePg) sql = sql.replace('mfa_enabled INTEGER', 'mfa_enabled INTEGER').replace('enabled INTEGER', 'enabled INTEGER');
    await query(sql);
  }
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword.length >= 12) {
    const existing = await query('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!existing.rows.length) {
      await query('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
        [id(), adminEmail, process.env.ADMIN_NAME || 'KD Admin', await bcrypt.hash(adminPassword, 12), 'admin', now()]);
      console.log('Bootstrap admin account created from environment.');
    }
  }
}
function sessionStore() {
  if (usePg) {
    const PgStore = require('connect-pg-simple')(session);
    return new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: true });
  }
  const SQLiteStore = require('connect-sqlite3')(session);
  return new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir, table: 'user_sessions' });
}
app.use(session({
  name: 'kd.hologram.sid',
  secret: process.env.SESSION_SECRET || (isProd ? '' : 'development-only-change-this-session-secret'),
  store: sessionStore(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 12 }
}));
const audit = async (req, action, detail = '') => {
  await query('INSERT INTO audit_logs (id,user_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?)',
    [id(), req.session?.user?.id || null, action, String(detail).slice(0, 500), req.ip, now()]);
};
const safeUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, mfa_enabled: Boolean(u.mfa_enabled) });
const auth = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Sign in required' });
const admin = (req, res, next) => req.session?.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator role required' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 5 } });
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'KD Hologram', version: '0.2.0', database: usePg ? 'postgresql' : 'sqlite', mode: 'workspace' }));
app.get('/api/config', (_req, res) => res.json({ appName: 'KD Hologram', company: 'KD Industries', registrationOpen: process.env.ALLOW_SIGNUP === 'true', providerConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY) }));
app.get('/api/auth/me', (req, res) => res.json({ user: req.session?.user || null }));
app.post('/api/auth/register', async (req, res) => {
  try {
    if (process.env.ALLOW_SIGNUP !== 'true') return res.status(403).json({ error: 'Registration is disabled. Ask your workspace administrator.' });
    const { email, name, password } = req.body || {};
    if (!/^\S+@\S+\.\S+$/.test(email || '') || !name?.trim() || (password || '').length < 12) return res.status(400).json({ error: 'Enter a valid email, name, and password of at least 12 characters.' });
    const user = { id: id(), email: email.trim().toLowerCase(), name: name.trim().slice(0,100), password_hash: await bcrypt.hash(password, 12), role: 'member', created_at: now() };
    await query('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)', [user.id,user.email,user.name,user.password_hash,user.role,user.created_at]);
    req.session.user = safeUser(user); await audit(req, 'auth.register', user.email); res.status(201).json({ user: req.session.user });
  } catch (e) { res.status(400).json({ error: 'Registration failed. The email may already be in use.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password, token } = req.body || {};
  const result = await query('SELECT * FROM users WHERE email = ?', [(email || '').trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) { await audit(req, 'auth.login_failed', email || ''); return res.status(401).json({ error: 'Email or password is incorrect.' }); }
  if (user.mfa_enabled) {
    const speakeasy = require('speakeasy');
    if (!token || !speakeasy.totp.verify({ secret: user.mfa_secret, encoding: 'base32', token: String(token), window: 1 })) return res.status(401).json({ error: 'A valid authenticator code is required.', mfaRequired: true });
  }
  req.session.regenerate(async err => {
    if (err) return res.status(500).json({ error: 'Could not create secure session.' });
    req.session.user = safeUser(user);
    await audit(req, 'auth.login', user.email);
    req.session.save(e => e ? res.status(500).json({ error: 'Session could not be saved.' }) : res.json({ user: req.session.user }));
  });
});
app.post('/api/auth/logout', auth, async (req,res) => { await audit(req,'auth.logout'); req.session.destroy(()=>{res.clearCookie('kd.hologram.sid');res.json({ok:true});}); });
app.post('/api/auth/mfa/setup', auth, async (req,res) => {
  const speakeasy = require('speakeasy');
  const secret = speakeasy.generateSecret({ name: 'KD Hologram (' + req.session.user.email + ')' });
  req.session.pendingMfaSecret = secret.base32;
  res.json({ secret: secret.base32, otpauth_url: secret.otpauth_url, instructions: 'Add this secret to an authenticator app, then verify with /api/auth/mfa/verify.' });
});
app.post('/api/auth/mfa/verify', auth, async (req,res) => {
  const speakeasy = require('speakeasy');
  const secret = req.session.pendingMfaSecret;
  if (!secret || !speakeasy.totp.verify({ secret, encoding: 'base32', token: String(req.body?.token || ''), window: 1 })) return res.status(400).json({error:'Invalid code.'});
  await query('UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?', [secret, req.session.user.id]);
  req.session.user.mfa_enabled = true; delete req.session.pendingMfaSecret;
  await audit(req,'auth.mfa_enabled'); res.json({ok:true});
});
app.get('/api/conversations', auth, async (req,res) => {
  const r = await query('SELECT id,title,model,parent_id,created_at,updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100',[req.session.user.id]);
  res.json({conversations:r.rows});
});
app.post('/api/conversations', auth, async (req,res) => {
  const cid=id(), stamp=now(), title=(req.body?.title || 'New conversation').trim().slice(0,160);
  await query('INSERT INTO conversations (id,user_id,title,model,parent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',[cid,req.session.user.id,title,req.body?.model || null,req.body?.parent_id || null,stamp,stamp]);
  await audit(req,'conversation.created',cid); res.status(201).json({conversation:{id:cid,title,model:req.body?.model || null,created_at:stamp,updated_at:stamp}});
});
app.get('/api/conversations/:id/messages', auth, async (req,res) => {
  const c=await query('SELECT id FROM conversations WHERE id = ? AND user_id = ?',[req.params.id,req.session.user.id]);
  if(!c.rows.length) return res.status(404).json({error:'Conversation not found'});
  const r=await query('SELECT id,role,content,model,parent_message_id,created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC',[req.params.id,req.session.user.id]);
  res.json({messages:r.rows});
});
app.post('/api/chat', auth, async (req,res) => {
  const { message, conversationId, model, parentMessageId, files = [] } = req.body || {};
  if (!message?.trim()) return res.status(400).json({error:'Message is required'});
  if (message.length > 50000) return res.status(413).json({error:'Message is too long'});
  let cid=conversationId;
  if (cid) { const own=await query('SELECT id FROM conversations WHERE id = ? AND user_id = ?',[cid,req.session.user.id]); if(!own.rows.length) return res.status(404).json({error:'Conversation not found'}); }
  else { cid=id(); const stamp=now(); await query('INSERT INTO conversations (id,user_id,title,model,parent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',[cid,req.session.user.id,message.trim().slice(0,80),model || null,null,stamp,stamp]); }
  const configResult = model && model !== 'Auto · Smart route' ? await query('SELECT * FROM model_configs WHERE enabled = 1 AND name = ?',[model]) : {rows:[]};
  const cfg=configResult.rows[0];
  const apiKey=cfg?.api_key || process.env.OPENAI_API_KEY;
  const baseUrl=(cfg?.base_url || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
  const modelName=cfg?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const userText = message + (files.length ? '\n\nAttached file context:\n' + files.filter(x=>typeof x.content==='string').map(x=>x.name+':\n'+x.content.slice(0,20000)).join('\n\n') : '');
  const mid=id(), stamp=now();
  await query('INSERT INTO messages (id,conversation_id,user_id,role,content,model,parent_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)',[mid,cid,req.session.user.id,'user',userText,model || null,parentMessageId || null,stamp]);
  await query('UPDATE conversations SET updated_at = ?, model = COALESCE(?,model) WHERE id = ?',[stamp,model || null,cid]);
  if (!apiKey) {
    const fallback='KD Hologram is ready to connect, but no AI provider key is configured on the server yet. Set OPENAI_API_KEY (or add a provider under Admin → Models) in your environment. Provider keys must remain server-side.';
    const aid=id(); await query('INSERT INTO messages (id,conversation_id,user_id,role,content,model,parent_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)',[aid,cid,req.session.user.id,'assistant',fallback,modelName,mid,now()]);
    await audit(req,'chat.provider_missing',cid);
    return res.json({conversationId:cid,userMessageId:mid,messageId:aid,content:fallback,providerConfigured:false});
  }
  const history=await query('SELECT role,content FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20',[cid,req.session.user.id]);
  const messages=history.rows.reverse().map(m=>({role:m.role,content:m.content}));
  res.setHeader('Content-Type','text/event-stream; charset=utf-8'); res.setHeader('Cache-Control','no-cache, no-transform'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders?.();
  const emit=(type,data)=>res.write('data: '+JSON.stringify({type,...data})+'\n\n');
  let full='';
  try {
    const upstream=await fetch(baseUrl+'/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:modelName,messages,stream:true}),signal:AbortSignal.timeout(120000)});
    if(!upstream.ok){const detail=(await upstream.text()).slice(0,800);throw new Error('Provider error '+upstream.status+': '+detail);}
    const reader=upstream.body.getReader(), decoder=new TextDecoder(); let buffer='';
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const chunks=buffer.split('\n');buffer=chunks.pop()||'';for(const line of chunks){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;try{const obj=JSON.parse(data);const delta=obj.choices?.[0]?.delta?.content;if(delta){full+=delta;emit('delta',{text:delta});}}catch{}}}
    const aid=id(); await query('INSERT INTO messages (id,conversation_id,user_id,role,content,model,parent_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)',[aid,cid,req.session.user.id,'assistant',full,modelName,mid,now()]);
    await query('UPDATE conversations SET updated_at = ? WHERE id = ?',[now(),cid]); await audit(req,'chat.completed',modelName);
    emit('done',{conversationId:cid,userMessageId:mid,messageId:aid,model:modelName});res.end();
  } catch(e) {
    emit('error',{message:isProd?'The model request failed. Check provider configuration and server logs.':e.message});
    res.end();
  }
});
app.post('/api/uploads', auth, upload.array('files',5), async (req,res) => {
  const allowed = new Set(['text/plain','text/markdown','text/csv','application/json']);
  const results=[];
  for(const f of (req.files||[])){
    if(!allowed.has(f.mimetype) && !/\.(txt|md|csv|json)$/i.test(f.originalname)) continue;
    const content=f.buffer.toString('utf8').slice(0,200000), uid=id();
    await query('INSERT INTO uploads (id,user_id,name,mime,content,created_at) VALUES (?,?,?,?,?,?)',[uid,req.session.user.id,f.originalname,f.mimetype,content,now()]);
    results.push({id:uid,name:f.originalname,mime:f.mimetype,content:content.slice(0,20000)});
  }
  await audit(req,'files.uploaded',results.map(f=>f.name).join(','));
  res.json({files:results,notice:'Text, Markdown, CSV and JSON are supported in this lightweight starter. Add a vetted PDF/DOCX extraction pipeline for richer documents.'});
});
app.get('/api/uploads', auth, async (req,res)=>{const r=await query('SELECT id,name,mime,created_at FROM uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',[req.session.user.id]);res.json({files:r.rows});});
app.get('/api/tools', auth, (_req,res)=>{let tools=[];try{tools=JSON.parse(process.env.MCP_TOOLS_JSON||'[]').map(t=>({name:t.name,description:t.description||'',enabled:Boolean(t.enabled)}));}catch{}res.json({tools,notice:'MCP tool discovery and execution require an allowlisted server-side MCP client; arbitrary command execution is intentionally not enabled.'});});
app.get('/api/admin/overview', auth, admin, async (req,res)=>{
  const [users,convos,logs,models]=await Promise.all([
    query('SELECT id,email,name,role,mfa_enabled,created_at FROM users ORDER BY created_at DESC LIMIT 100'),
    query('SELECT COUNT(*) AS count FROM conversations'),query('SELECT id,user_id,action,detail,ip,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100'),
    query('SELECT id,name,base_url,model,enabled,created_at FROM model_configs ORDER BY created_at DESC')
  ]);
  res.json({users:users.rows,conversations:Number(convos.rows[0]?.count||0),audit:logs.rows,models:models.rows});
});
app.post('/api/admin/models', auth, admin, async (req,res)=>{
  const {name,base_url,model,api_key}=req.body||{};
  if(!name||!/^https:\/\//.test(base_url||'')||!model||!api_key)return res.status(400).json({error:'Name, HTTPS base URL, model ID and API key are required.'});
  const mid=id(); await query('INSERT INTO model_configs (id,name,base_url,model,api_key,enabled,created_at) VALUES (?,?,?,?,?,?,?)',[mid,name.slice(0,80),base_url.replace(/\/$/,''),model,api_key,1,now()]);
  await audit(req,'admin.model_added',name);res.status(201).json({id:mid,name,base_url,model,enabled:true});
});
app.patch('/api/admin/users/:id/role', auth, admin, async (req,res)=>{
  const role=req.body?.role;
  if(!['admin','member','viewer'].includes(role))return res.status(400).json({error:'Role must be admin, member, or viewer.'});
  if(req.params.id===req.session.user.id && role!=='admin')return res.status(400).json({error:'You cannot remove your own admin role.'});
  const r=await query('UPDATE users SET role = ? WHERE id = ?',[role,req.params.id]);
  if(!r.changes)return res.status(404).json({error:'User not found'});await audit(req,'admin.role_changed',req.params.id+' → '+role);res.json({ok:true});
});
app.get('/api/admin/audit', auth, admin, async (req,res)=>{const r=await query('SELECT id,user_id,action,detail,ip,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 200');res.json({events:r.rows});});
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(err.code==='LIMIT_FILE_SIZE'?413:500).json({error:err.code==='LIMIT_FILE_SIZE'?'Each file must be under 8 MB.':(isProd?'Internal server error':err.message)});});
(async()=>{if(isProd&&(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)){console.error('SESSION_SECRET must be set to a random value of at least 32 characters in production.');process.exit(1);}await init();app.use(express.static(path.join(__dirname),{index:'index.html'}));app.get('*path',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));app.listen(port,'0.0.0.0',()=>console.log('KD Hologram listening on port '+port+' ('+(usePg?'PostgreSQL':'SQLite')+')'));})().catch(e=>{console.error('Startup failed:',e);process.exit(1);});
