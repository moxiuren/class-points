import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const app = express();
app.use(express.json());

// CORS configuration
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Pin, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static public folder
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Constant-time PIN verification
function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  const h1 = crypto.createHmac('sha256', 'salt-key').update(aBuf).digest();
  const h2 = crypto.createHmac('sha256', 'salt-key').update(bBuf).digest();
  return crypto.timingSafeEqual(h1, h2);
}

function verifyPin(req, res, next) {
  const pin = req.headers['x-pin'];
  if (!pin) {
    return res.status(401).json({ error: 'bad pin' });
  }
  const expectedPin = process.env.PIN_CODE || '1234';
  if (!safeCompare(pin, expectedPin)) {
    return res.status(401).json({ error: 'bad pin' });
  }
  next();
}

// SSE registry
const sseClients = new Set();

function broadcast(eventData) {
  const payload = `event: points_changed\ndata: ${JSON.stringify(eventData)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Every 30 seconds, send a keep-alive comment
setInterval(() => {
  for (const client of sseClients) {
    client.write(':keep-alive\n\n');
  }
}, 30000);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/classes', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.created_at, COUNT(s.id) as student_count
      FROM classes c
      LEFT JOIN students s ON c.id = s.class_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classes', verifyPin, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const stmt = db.prepare('INSERT INTO classes (name) VALUES (?)');
    const result = stmt.run(name.trim());
    res.json({ id: result.lastInsertRowid, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classes/:id/students', (req, res) => {
  const classId = req.params.id;
  try {
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!classExists) {
      return res.status(404).json({ error: 'class not found' });
    }
    const students = db.prepare(`
      SELECT 
        s.id, 
        s.name, 
        s.color, 
        COALESCE(SUM(pe.delta), 0) AS points
      FROM students s
      LEFT JOIN point_events pe ON s.id = pe.student_id AND pe.undone_at IS NULL
      WHERE s.class_id = ?
      GROUP BY s.id
      ORDER BY s.name ASC
    `).all(classId);
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classes/:id/students', verifyPin, (req, res) => {
  const classId = req.params.id;
  const { names } = req.body;
  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'names array is required' });
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'each name must be a non-empty string' });
    }
  }
  try {
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!classExists) {
      return res.status(404).json({ error: 'class not found' });
    }
    
    const COLORS = ['#ef4444','#f97316','#f59e0b','#eab308','#84cc16','#22c55e','#14b8a6','#06b6d4','#3b82f6','#8b5cf6','#a855f7','#ec4899'];
    const existingColors = db.prepare('SELECT color FROM students WHERE class_id = ?').all(classId).map(row => row.color);
    const existingSet = new Set(existingColors);
    let unused = COLORS.filter(c => !existingSet.has(c));
    
    const insertStmt = db.prepare('INSERT INTO students (class_id, name, color) VALUES (?, ?, ?)');
    
    db.exec('BEGIN TRANSACTION;');
    try {
      for (const name of names) {
        const trimmedName = name.trim();
        if (unused.length === 0) {
          unused = [...COLORS];
        }
        const color = unused.shift();
        insertStmt.run(classId, trimmedName, color);
      }
      db.exec('COMMIT;');
      res.json({ added: names.length });
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', verifyPin, (req, res) => {
  const studentId = req.params.id;
  try {
    const student = db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
    if (!student) {
      return res.status(404).json({ error: 'student not found' });
    }
    db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/points', verifyPin, (req, res) => {
  const studentId = req.params.id;
  const { delta, reason = '' } = req.body;
  if (typeof delta !== 'number' || delta === 0 || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'delta must be a non-zero integer' });
  }
  if (typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string' });
  }
  try {
    const student = db.prepare('SELECT class_id FROM students WHERE id = ?').get(studentId);
    if (!student) {
      return res.status(404).json({ error: 'student not found' });
    }
    const classId = student.class_id;
    
    const stmt = db.prepare(`
      INSERT INTO point_events (student_id, class_id, delta, reason)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(studentId, classId, delta, reason);
    const eventId = result.lastInsertRowid;
    
    const event = db.prepare('SELECT id, student_id, class_id, delta, reason, created_at FROM point_events WHERE id = ?').get(eventId);
    
    broadcast({
      class_id: event.class_id,
      event_id: event.id,
      student_id: event.student_id,
      delta: event.delta,
      reason: event.reason,
      created_at: event.created_at
    });
    
    res.json({ id: eventId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/:eventId/undo', verifyPin, (req, res) => {
  const eventId = req.params.eventId;
  try {
    const event = db.prepare('SELECT id, student_id, class_id, delta, reason, created_at, undone_at FROM point_events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'event not found' });
    }
    if (event.undone_at !== null) {
      return res.status(409).json({ error: 'already undone' });
    }
    
    db.prepare('UPDATE point_events SET undone_at = (unixepoch()) WHERE id = ?').run(eventId);
    
    broadcast({
      class_id: event.class_id,
      event_id: event.id,
      student_id: event.student_id,
      delta: 0,
      reason: event.reason,
      created_at: event.created_at,
      undone: true
    });
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/events', (req, res) => {
  const studentId = req.params.id;
  try {
    const student = db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
    if (!student) {
      return res.status(404).json({ error: 'student not found' });
    }
    const rows = db.prepare(`
      SELECT id, delta, reason, created_at, undone_at,
             (CASE WHEN undone_at IS NULL THEN 1 ELSE 0 END) AS undoable
      FROM point_events
      WHERE student_id = ?
      ORDER BY id DESC
    `).all(studentId);
    
    const mapped = rows.map(r => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      created_at: r.created_at,
      undone_at: r.undone_at,
      undoable: r.undoable === 1
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classes/:id/events', (req, res) => {
  const classId = req.params.id;
  try {
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!classExists) {
      return res.status(404).json({ error: 'class not found' });
    }
    const events = db.prepare(`
      SELECT 
        pe.id, 
        pe.student_id, 
        s.name, 
        s.color, 
        pe.delta, 
        pe.reason, 
        pe.created_at, 
        pe.undone_at
      FROM point_events pe
      JOIN students s ON pe.student_id = s.id
      WHERE pe.class_id = ?
      ORDER BY pe.id DESC
      LIMIT 200
    `).all(classId);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  
  sseClients.add(res);
  
  res.write(':ok\n\n');
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
