require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════════════
const db = new Database(path.join(__dirname, 'taskflow.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT DEFAULT '',
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    due_date TEXT DEFAULT '',
    reminder_time TEXT DEFAULT '',
    reminded INTEGER DEFAULT 0,
    source TEXT DEFAULT 'app',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ═══════════════════════════════════════════════════════════════════════
// TWILIO SETUP
// ═══════════════════════════════════════════════════════════════════════
let tw = null;
const TW_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const MY_NUM = process.env.MY_WHATSAPP_NUMBER || '';

try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio connected');
  } else {
    console.log('⚠️  No Twilio credentials — WhatsApp will be disabled');
  }
} catch (e) {
  console.log('⚠️  Twilio error:', e.message);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════
const genId = () => 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
const PRI = { high: '🔴', medium: '🟠', low: '🟢' };
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const todayStr = () => new Date().toISOString().split('T')[0];

async function sendWA(body) {
  if (!tw || !MY_NUM) return { ok: false, reason: 'Twilio not configured' };
  try {
    const msg = await tw.messages.create({ from: TW_FROM, to: MY_NUM, body });
    console.log('📱 Sent:', msg.sid);
    return { ok: true, sid: msg.sid };
  } catch (e) {
    console.error('📱 Send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

function parseIncoming(text) {
  const r = { title: text.trim(), priority: 'medium', dueDate: '', command: null };
  const low = text.toLowerCase().trim();

  // Commands
  if (/^(list|tasks|pending|show)$/i.test(low)) return { ...r, command: 'list' };
  if (/^(help|\?)$/i.test(low)) return { ...r, command: 'help' };
  if (/^done\b/i.test(low)) return { ...r, command: 'done', title: low.replace(/^done\s*/i, '') };
  if (/^(delete|remove)\b/i.test(low)) return { ...r, command: 'delete', title: low.replace(/^(delete|remove)\s*/i, '') };
  if (/^(doing|start)\b/i.test(low)) return { ...r, command: 'doing', title: low.replace(/^(doing|start)\s*/i, '') };

  // Priority
  if (/\b(urgent|important|asap|critical|high priority)\b/i.test(low)) {
    r.priority = 'high';
    r.title = r.title.replace(/\b(urgent|important|asap|critical|high priority)\b/gi, '');
  } else if (/\b(low priority|no rush|whenever)\b/i.test(low)) {
    r.priority = 'low';
    r.title = r.title.replace(/\b(low priority|no rush|whenever)\b/gi, '');
  }

  // Dates
  if (/\btoday\b/i.test(low)) {
    r.dueDate = todayStr();
    r.title = r.title.replace(/\btoday\b/gi, '');
  } else if (/\btomorrow\b/i.test(low)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    r.dueDate = d.toISOString().split('T')[0];
    r.title = r.title.replace(/\btomorrow\b/gi, '');
  } else if (/\bnext week\b/i.test(low)) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    r.dueDate = d.toISOString().split('T')[0];
    r.title = r.title.replace(/\bnext week\b/gi, '');
  }

  r.title = r.title.replace(/\s+/g, ' ').trim();
  return r;
}

// ═══════════════════════════════════════════════════════════════════════
// API: TASKS CRUD
// ═══════════════════════════════════════════════════════════════════════

// Get all tasks
app.get('/api/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  res.json(rows);
});

// Create task (from app)
app.post('/api/tasks', async (req, res) => {
  const { title, notes, priority, status, due_date, reminder_time } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });

  const id = genId();
  db.prepare(
    `INSERT INTO tasks (id, title, notes, priority, status, due_date, reminder_time, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'app')`
  ).run(id, title.trim(), notes || '', priority || 'medium', status || 'pending', due_date || '', reminder_time || '');

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(task);
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
  const { title, notes, priority, status, due_date, reminder_time } = req.body;
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    `UPDATE tasks SET title=?, notes=?, priority=?, status=?, due_date=?, reminder_time=?, reminded=0, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    title ?? existing.title, notes ?? existing.notes, priority ?? existing.priority,
    status ?? existing.status, due_date ?? existing.due_date, reminder_time ?? existing.reminder_time,
    req.params.id
  );

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(task);
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
// API: SEND WHATSAPP FROM APP (one-click)
// ═══════════════════════════════════════════════════════════════════════

// Send single task to WhatsApp
app.post('/api/send-task/:id', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const p = PRI[task.priority] || '🟠';
  let msg = `📋 *Task Reminder*\n\n${p} *${task.title}*`;
  if (task.notes) msg += `\n${task.notes}`;
  if (task.due_date) msg += `\n📅 Due: ${fmtDate(task.due_date)}`;
  msg += `\n\n_Reply "done ${task.title.slice(0, 20)}" to mark complete_`;

  const result = await sendWA(msg);
  if (result.ok) {
    db.prepare('UPDATE tasks SET wa_sent = 1 WHERE id = ?').run(task.id);
  }
  res.json(result);
});

// Send all pending tasks
app.post('/api/send-all', async (req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks WHERE status != 'done' ORDER BY priority DESC, due_date ASC").all();
  if (tasks.length === 0) return res.json({ ok: true, message: 'No pending tasks' });

  let msg = `📋 *Pending Tasks (${tasks.length})*\n`;
  tasks.forEach((t, i) => {
    const od = t.due_date && t.status !== 'done' && new Date(t.due_date + 'T00:00:00') < new Date(new Date().setHours(0,0,0,0));
    msg += `\n${i + 1}. ${PRI[t.priority]} ${t.title}`;
    if (t.due_date) msg += ` _(${fmtDate(t.due_date)}${od ? ' ⚠️' : ''})_`;
  });
  msg += `\n\n_Reply "done <task>" to mark complete_`;

  const result = await sendWA(msg);
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK: RECEIVE WHATSAPP MESSAGES → CREATE TASKS
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/webhook/whatsapp', async (req, res) => {
  const body = req.body.Body || '';
  const from = req.body.From || '';
  console.log(`📨 WhatsApp from ${from}: ${body}`);

  const parsed = parseIncoming(body);
  const twiml = new twilio.twiml.MessagingResponse();

  // ── HELP ──
  if (parsed.command === 'help') {
    twiml.message(
      `🤖 *TaskFlow Commands*\n\n` +
      `📝 *Add task:* Just type it!\n` +
      `   Example: "Buy groceries tomorrow urgent"\n\n` +
      `📋 *List tasks:* "list" or "tasks"\n` +
      `✅ *Mark done:* "done buy groceries"\n` +
      `🔄 *Start task:* "doing buy groceries"\n` +
      `🗑️ *Delete:* "delete buy groceries"\n\n` +
      `_Priority: add "urgent" or "low priority"_\n` +
      `_Dates: add "today", "tomorrow", "next week"_`
    );
  }

  // ── LIST ──
  else if (parsed.command === 'list') {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status != 'done' ORDER BY priority DESC, due_date ASC").all();
    if (tasks.length === 0) {
      twiml.message('✨ No pending tasks! You\'re all caught up.');
    } else {
      let msg = `📋 *Pending Tasks (${tasks.length})*\n`;
      tasks.forEach((t, i) => {
        const st = t.status === 'in-progress' ? ' 🔄' : '';
        msg += `\n${i + 1}. ${PRI[t.priority]} ${t.title}${st}`;
        if (t.due_date) msg += ` _(${fmtDate(t.due_date)})_`;
      });
      twiml.message(msg);
    }
  }

  // ── DONE ──
  else if (parsed.command === 'done') {
    const search = parsed.title.toLowerCase();
    const task = db.prepare("SELECT * FROM tasks WHERE status != 'done' AND LOWER(title) LIKE ? ORDER BY created_at DESC")
      .get(`%${search}%`);
    if (task) {
      db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(task.id);
      twiml.message(`✅ Done: *${task.title}*\n\nNice work! 🎉`);
    } else {
      twiml.message(`❌ Couldn't find a pending task matching "${parsed.title}"\n\nType "list" to see your tasks.`);
    }
  }

  // ── DOING ──
  else if (parsed.command === 'doing') {
    const search = parsed.title.toLowerCase();
    const task = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND LOWER(title) LIKE ? ORDER BY created_at DESC")
      .get(`%${search}%`);
    if (task) {
      db.prepare("UPDATE tasks SET status = 'in-progress', updated_at = datetime('now') WHERE id = ?").run(task.id);
      twiml.message(`🔄 Started: *${task.title}*\n\nGood luck!`);
    } else {
      twiml.message(`❌ Couldn't find a pending task matching "${parsed.title}"`);
    }
  }

  // ── DELETE ──
  else if (parsed.command === 'delete') {
    const search = parsed.title.toLowerCase();
    const task = db.prepare("SELECT * FROM tasks WHERE LOWER(title) LIKE ? ORDER BY created_at DESC")
      .get(`%${search}%`);
    if (task) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      twiml.message(`🗑️ Deleted: *${task.title}*`);
    } else {
      twiml.message(`❌ Couldn't find a task matching "${parsed.title}"`);
    }
  }

  // ── ADD NEW TASK ──
  else {
    if (!parsed.title) {
      twiml.message('❓ Send a task to add it, or type "help" for commands.');
    } else {
      const id = genId();
      db.prepare(
        `INSERT INTO tasks (id, title, priority, due_date, source) VALUES (?, ?, ?, ?, 'whatsapp')`
      ).run(id, parsed.title, parsed.priority, parsed.dueDate);

      let msg = `✅ *Task added!*\n\n${PRI[parsed.priority]} ${parsed.title}`;
      if (parsed.dueDate) msg += `\n📅 Due: ${fmtDate(parsed.dueDate)}`;
      msg += `\n\n_Type "list" to see all tasks_`;
      twiml.message(msg);
    }
  }

  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════
// REMINDER SYSTEM (checks every 60 seconds)
// ═══════════════════════════════════════════════════════════════════════
setInterval(async () => {
  const now = new Date();
  const nd = todayStr();
  const nt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const due = db.prepare(
    "SELECT * FROM tasks WHERE status != 'done' AND due_date = ? AND reminder_time = ? AND reminded = 0"
  ).all(nd, nt);

  for (const task of due) {
    const msg = `⏰ *Reminder*\n\n${PRI[task.priority]} *${task.title}*` +
      (task.notes ? `\n${task.notes}` : '') +
      `\n📅 Due: ${fmtDate(task.due_date)}` +
      `\n\n_Reply "done ${task.title.slice(0, 20)}" to complete_`;

    await sendWA(msg);
    db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(task.id);
    console.log('⏰ Reminder sent for:', task.title);
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK + CATCH ALL
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', twilio: !!tw, tasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TaskFlow running on port ${PORT}`);
  console.log(`📱 WhatsApp: ${tw ? 'Connected' : 'Not configured'}`);
  console.log(`💾 Database: ${db.prepare('SELECT COUNT(*) as c FROM tasks').get().c} tasks\n`);
});
