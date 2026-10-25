const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

   const pool = mysql.createPool({
     host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
     port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
     user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
     password: process.env.DB_PASS || process.env.MYSQLPASSWORD || '',
     database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'rental_ps',
     connectionLimit: 10
   });

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sessions = new Map(); // token -> user id (hilang saat server restart)
const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const same = (p, h) => { const a = Buffer.from(hash(p, h.split(':')[0])), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const wrap = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: 'Kesalahan server' }); });
const pub = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, saldo_detik: u.saldo_detik });
const open = u => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, u.id); return { token: t, user: pub(u) }; };

const auth = wrap(async (req, res, next) => {
  const id = sessions.get((req.headers.authorization || '').slice(7));
  if (!id) return res.status(401).json({ error: 'Belum login' });
  const [[u]] = await pool.query('SELECT id,username,name,role,saldo_detik FROM users WHERE id=?', [id]);
  if (!u) return res.status(401).json({ error: 'Sesi tidak valid' });
  req.user = u; next();
});

app.get('/api/ping', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: 1 }); }));

app.post('/api/register', wrap(async (req, res) => {
  const { username = '', password = '', name = '' } = req.body;
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username 3-30 karakter (huruf, angka, _)' });
  if (password.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
  if (!name.trim()) return res.status(400).json({ error: 'Nama wajib diisi' });
  const [ex] = await pool.query('SELECT id FROM users WHERE username=?', [username]);
  if (ex.length) return res.status(409).json({ error: 'Username sudah dipakai' });
  const [r] = await pool.query('INSERT INTO users(username,password_hash,name) VALUES(?,?,?)', [username, hash(password), name.trim()]);
  res.json(open({ id: r.insertId, username, name: name.trim(), role: 'user', saldo_detik: 0 }));
}));

app.post('/api/login', wrap(async (req, res) => {
  const [[u]] = await pool.query('SELECT * FROM users WHERE username=?', [req.body.username || '']);
  if (!u || !same(req.body.password || '', u.password_hash)) return res.status(401).json({ error: 'Username atau password salah' });
  res.json(open(u));
}));

app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

// Admin: semua riwayat. User: riwayat sendiri + sesi aktif semua TV (agar monitor akurat).
app.get('/api/rentals', auth, wrap(async (req, res) => {
  const adm = req.user.role === 'admin' ? 1 : 0;
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS pemain FROM rentals r JOIN users u ON u.id=r.user_id
     WHERE ?=1 OR r.user_id=? OR r.status<>'paid' ORDER BY r.start_at DESC LIMIT 500`, [adm, req.user.id]);
  const map = {};
  rows.forEach(r => { r.fnb = []; map[r.id] = r; });
  if (rows.length) {
    const [f] = await pool.query('SELECT rental_id,item,price FROM rental_fnb WHERE rental_id IN (?)', [rows.map(r => r.id)]);
    f.forEach(x => map[x.rental_id].fnb.push({ item: x.item, price: x.price }));
  }
  res.json(rows);
}));

app.put('/api/rentals/:id', auth, wrap(async (req, res) => {
  const b = req.body, id = req.params.id, admin = req.user.role === 'admin';
  const [[ex]] = await pool.query('SELECT user_id FROM rentals WHERE id=?', [id]);
  if (ex && ex.user_id !== req.user.id && !admin) return res.status(403).json({ error: 'Ini bukan sesi Anda' });
  const [busy] = await pool.query("SELECT id FROM rentals WHERE tv_id=? AND status<>'paid' AND id<>?", [b.tv_id, id]);
  if (busy.length && b.status !== 'paid') return res.status(409).json({ error: b.tv_id + ' sedang dipakai' });
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.query(
      `INSERT INTO rentals(id,tv_id,console,user_id,pkg,status,start_at,end_at,duration,stop_at,paid_at,bill_rental,sisa_detik)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), end_at=VALUES(end_at), duration=VALUES(duration), stop_at=VALUES(stop_at),
         paid_at=VALUES(paid_at), bill_rental=VALUES(bill_rental), sisa_detik=VALUES(sisa_detik)`,
      [id, b.tv_id, b.console ?? null, ex ? ex.user_id : req.user.id, b.pkg, b.status, b.start_at, b.end_at ?? null,
       b.duration ?? null, b.stop_at ?? null, b.paid_at ?? null, b.bill_rental ?? 0, b.sisa_detik ?? 0]);
    await c.query('DELETE FROM rental_fnb WHERE rental_id=?', [id]);
    for (const f of b.fnb || []) await c.query('INSERT INTO rental_fnb(rental_id,item,price) VALUES(?,?,?)', [id, f.item, f.price]);
    await c.commit();
    res.json({ ok: 1 });
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}));

// Tambah/kurangi sisa waktu akun (tidak pernah negatif)
app.post('/api/users/:id/saldo', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  if (id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Ditolak' });
  await pool.query('UPDATE users SET saldo_detik=GREATEST(saldo_detik+?,0) WHERE id=?', [parseInt(req.body.add) || 0, id]);
  res.json({ ok: 1 });
}));

(async () => {
  const [a] = await pool.query("SELECT id FROM users WHERE username='admin1234'");
  if (!a.length) await pool.query("INSERT INTO users(username,password_hash,name,role) VALUES('admin1234',?,'Administrator','admin')", [hash('kelompok10')]);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('POS Rental PS berjalan di http://localhost:' + port));
})().catch(e => { console.error('Gagal terhubung ke MySQL:', e.message); process.exit(1); });
