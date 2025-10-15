import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
dotenv.config();
const { Pool } = pkg;
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'devtoken';
const SALON_ID = '00000000-0000-0000-0000-000000000001';
function requireAdmin(req,res,next){ const auth=req.headers.authorization||''; const token=auth.startsWith('Bearer ')?auth.slice(7):''; if(token!==ADMIN_TOKEN) return res.status(401).json({error:'unauthorized'}); next(); }
app.get('/api/health',(req,res)=>res.json({ok:true}));

// Clients
app.post('/api/clients', async (req,res)=>{ const { name, phone, email, birthdate, marketingConsent, notes } = req.body;
  if(!name) return res.status(400).json({error:'name required'});
  const { rows } = await pool.query(`INSERT INTO client(id, salon_id, name, phone, email, birthdate, marketing_consent, notes, gdpr_consent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
    [uuidv4(), SALON_ID, name, phone, email, birthdate||null, !!marketingConsent, notes||null]);
  res.status(201).json(rows[0]);
});
app.get('/api/clients', requireAdmin, async (req,res)=>{ const { rows } = await pool.query('SELECT * FROM client ORDER BY name ASC LIMIT 500'); res.json(rows); });
app.get('/api/clients/:id', requireAdmin, async (req,res)=>{
  const { id } = req.params; const c = await pool.query('SELECT * FROM client WHERE id=$1',[id]);
  if(!c.rowCount) return res.status(404).json({error:'not found'});
  const bookings = await pool.query(`SELECT b.*, s.name as service_name, st.name as staff_name FROM booking b LEFT JOIN service s ON s.id=b.service_id LEFT JOIN staff st ON st.id=b.staff_id WHERE b.client_id=$1 ORDER BY b.start_ts DESC`, [id]);
  const notes = await pool.query('SELECT * FROM client_note WHERE client_id=$1 ORDER BY created_at DESC',[id]);
  res.json({ client:c.rows[0], bookings:bookings.rows, notes:notes.rows });
});
app.post('/api/clients/:id/notes', requireAdmin, async (req,res)=>{
  const { id } = req.params; const { type='note', content, photo_url=null } = req.body;
  if(!content) return res.status(400).json({error:'content required'});
  const { rows } = await pool.query('INSERT INTO client_note(client_id, type, content, photo_url) VALUES($1,$2,$3,$4) RETURNING *',[id, type, content, photo_url]);
  res.status(201).json(rows[0]);
});

// Services & Staff
app.get('/api/services', async (req,res)=>{ const { rows } = await pool.query('SELECT * FROM service ORDER BY category, name'); res.json(rows); });
app.get('/api/staff', async (req,res)=>{ const { rows } = await pool.query('SELECT * FROM staff WHERE active=TRUE ORDER BY name'); res.json(rows); });

// Staff CRUD
app.post('/api/staff', requireAdmin, async (req,res)=>{
  const { name, role='Staff', color_hex='#6AA6FF', skills=[] } = req.body;
  if(!name) return res.status(400).json({ error:'name required' });
  const { rows } = await pool.query("INSERT INTO staff(salon_id,name,role,color_hex,active,skills) VALUES($1,$2,$3,$4,TRUE,$5) RETURNING *",
    [SALON_ID, name, role, color_hex, skills]);
  res.status(201).json(rows[0]);
});
app.patch('/api/staff/:id', requireAdmin, async (req,res)=>{
  const { id } = req.params; const { name, role, color_hex, active, skills } = req.body;
  const { rows } = await pool.query('UPDATE staff SET name=COALESCE($1,name), role=COALESCE($2,role), color_hex=COALESCE($3,color_hex), active=COALESCE($4,active), skills=COALESCE($5,skills) WHERE id=$6 RETURNING *',
    [name, role, color_hex, active, skills, id]);
  if(!rows.length) return res.status(404).json({ error:'not found' });
  res.json(rows[0]);
});
app.delete('/api/staff/:id', requireAdmin, async (req,res)=>{ const { id } = req.params; await pool.query('DELETE FROM staff WHERE id=$1',[id]); res.json({ ok:true }); });

// Availability (simplified)
app.post('/api/availability', async (req,res)=>{
  const { serviceId, staffId, dateStart, dateEnd } = req.body;
  if(!serviceId || !staffId || !dateStart || !dateEnd) return res.status(400).json({ error:'missing fields' });
  const svc = await pool.query('SELECT duration_min FROM service WHERE id=$1',[serviceId]);
  if(!svc.rowCount) return res.status(404).json({ error:'service not found' });
  const duration = svc.rows[0].duration_min;
  const start = new Date(dateStart); const end = new Date(dateEnd);
  const slots = []; const iter = new Date(start); iter.setHours(9,0,0,0);
  while (iter < end) { const s=new Date(iter); const e=new Date(iter.getTime()+duration*60000); if(e.getHours()<=18) slots.push({ start: s.toISOString(), end: e.toISOString() }); iter.setMinutes(iter.getMinutes()+30); }
  res.json({ slots });
});

// Bookings
app.post('/api/bookings', async (req,res)=>{
  const { clientId, staffId, serviceId, start, notes } = req.body;
  if(!clientId || !staffId || !serviceId || !start) return res.status(400).json({ error:'missing fields' });
  const svc = await pool.query('SELECT duration_min FROM service WHERE id=$1',[serviceId]);
  if(!svc.rowCount) return res.status(404).json({ error:'service not found' });
  const startTs = new Date(start); const endTs = new Date(startTs.getTime() + svc.rows[0].duration_min*60000);
  const { rows } = await pool.query(`INSERT INTO booking(id,salon_id,client_id,staff_id,service_id,start_ts,end_ts,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,'hold',$8) RETURNING *`,
    [uuidv4(), SALON_ID, clientId, staffId, serviceId, startTs, endTs, notes||null]);
  // Auto-email via Resend se configurato
  try{
    const cq = await pool.query('SELECT email, name FROM client WHERE id=$1',[clientId]);
    const sq = await pool.query('SELECT name FROM service WHERE id=$1',[serviceId]);
    if(cq.rowCount && cq.rows[0].email){
      const data = { name: cq.rows[0].name, service: (sq.rows[0]?.name)||'', date: startTs.toLocaleDateString('it-IT'), time: startTs.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}) };
      const subject = `Conferma prenotazione ${data.service}`;
      await sendEmailResend(cq.rows[0].email, subject, `<p>Ciao ${data.name}, la tua prenotazione per ${data.service} del ${data.date} alle ${data.time} è stata ricevuta.</p>`);
    }
  }catch(e){ console.warn('email fail', e?.message); }
  res.status(201).json(rows[0]);
});
app.get('/api/bookings', requireAdmin, async (req,res)=>{
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(`SELECT b.id,b.start_ts as start,b.end_ts as end,b.staff_id,b.service_id,b.status,c.name as client_name,s.name as service_name,b.client_id FROM booking b LEFT JOIN client c ON c.id=b.client_id LEFT JOIN service s ON s.id=b.service_id WHERE b.start_ts::date=$1::date ORDER BY b.start_ts ASC`, [date]);
  res.json(rows);
});
app.get('/api/bookings/week', requireAdmin, async (req,res)=>{
  const start = req.query.start ? new Date(req.query.start) : new Date();
  const day = (start.getDay()||7); const monday = new Date(start); monday.setDate(start.getDate()-day+1);
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  const { rows } = await pool.query(`SELECT b.id,b.start_ts as start,b.end_ts as end,b.staff_id,b.service_id,b.status,c.name as client_name,s.name as service_name,b.client_id FROM booking b LEFT JOIN client c ON c.id=b.client_id LEFT JOIN service s ON s.id=b.service_id WHERE b.start_ts::date BETWEEN $1::date AND $2::date ORDER BY b.start_ts ASC`, [monday, sunday]);
  res.json(rows);
});
app.patch('/api/bookings/:id', requireAdmin, async (req,res)=>{
  const { id } = req.params; const { status, notes, start, staffId } = req.body;
  if(start || staffId){
    const b = await pool.query('SELECT service_id FROM booking WHERE id=$1',[id]);
    if(!b.rowCount) return res.status(404).json({ error:'not found' });
    const svc = await pool.query('SELECT duration_min FROM service WHERE id=$1',[b.rows[0].service_id]);
    const st = start ? new Date(start) : null; const en = st ? new Date(st.getTime()+svc.rows[0].duration_min*60000) : null;
    const { rows } = await pool.query('UPDATE booking SET start_ts=COALESCE($1,start_ts), end_ts=COALESCE($2,end_ts), staff_id=COALESCE($3,staff_id), status=COALESCE($4,status), notes=COALESCE($5,notes) WHERE id=$6 RETURNING *',
      [st, en, staffId||null, status||null, notes||null, id]);
    return res.json(rows[0]);
  } else {
    const { rows } = await pool.query('UPDATE booking SET status=COALESCE($1,status), notes=COALESCE($2,notes) WHERE id=$3 RETURNING *',[status||null, notes||null, id]);
    if(!rows.length) return res.status(404).json({ error:'not found' });
    return res.json(rows[0]);
  }
});

// Upload stub
app.post('/api/upload', requireAdmin, async (req,res)=>{ const { base64, url } = req.body; if(url) return res.json({ url }); if(base64) return res.json({ url: 'https://files.example.com/'+uuidv4()+'.jpg' }); res.status(400).json({ error:'send base64 or url' }); });

// Reports & Exports
function quote(s){ return '"' + (String(s||'').replaceAll('"','""')) + '"'; }
app.get('/api/report/summary', requireAdmin, async (req,res)=>{
  const { date_from, date_to } = req.query; const from = date_from || new Date(new Date().getFullYear(), new Date().getMonth(), 1); const to = date_to || new Date();
  const byService = await pool.query(`SELECT s.name, COUNT(*) as count FROM booking b LEFT JOIN service s ON s.id=b.service_id WHERE b.start_ts::date BETWEEN $1::date AND $2::date AND b.status IN ('confirmed','completed','in_progress','ready') GROUP BY s.name ORDER BY count DESC`, [from,to]);
  const byStaff = await pool.query(`SELECT st.name, COUNT(*) as count FROM booking b LEFT JOIN staff st ON st.id=b.staff_id WHERE b.start_ts::date BETWEEN $1::date AND $2::date AND b.status IN ('confirmed','completed','in_progress','ready') GROUP BY st.name ORDER BY count DESC`, [from,to]);
  const totals = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='no_show') as noshow, COUNT(*) FILTER (WHERE status='cancelled') as cancelled, COUNT(*) as total FROM booking WHERE start_ts::date BETWEEN $1::date AND $2::date`, [from,to]);
  const revenue = await pool.query(`SELECT COALESCE(SUM(amount_eur),0) as revenue FROM payment WHERE status='paid' AND created_at::date BETWEEN $1::date AND $2::date`, [from,to]);
  res.json({ from, to, byService: byService.rows, byStaff: byStaff.rows, totals: totals.rows[0], revenue: revenue.rows[0].revenue });
});
app.get('/api/export/clients.csv', requireAdmin, async (req,res)=>{
  const { rows } = await pool.query('SELECT name, phone, email, marketing_consent FROM client ORDER BY name ASC');
  const csv = ['name,phone,email,marketing_consent'].concat(rows.map(r=>[r.name,r.phone,r.email,r.marketing_consent].map(quote).join(','))).join('\n');
  res.setHeader('Content-Type','text/csv'); res.send(csv);
});
app.get('/api/export/bookings.csv', requireAdmin, async (req,res)=>{
  const { rows } = await pool.query(`SELECT b.id, c.name as client, s.name as service, st.name as staff, b.start_ts, b.end_ts, b.status FROM booking b LEFT JOIN client c ON c.id=b.client_id LEFT JOIN service s ON s.id=b.service_id LEFT JOIN staff st ON st.id=b.staff_id ORDER BY b.start_ts DESC LIMIT 2000`);
  const head = 'id,client,service,staff,start,end,status';
  const csv = [head].concat(rows.map(r=>[r.id, r.client, r.service, r.staff, r.start_ts, r.end_ts, r.status].map(quote).join(','))).join('\n');
  res.setHeader('Content-Type','text/csv'); res.send(csv);
});

async function sendEmailResend(to, subject, html){
  const apiKey = process.env.RESEND_API_KEY; const senderEmail = process.env.SENDER_EMAIL || 'no-reply@example.com'; const senderName = process.env.SENDER_NAME || 'Le Mode';
  if(!apiKey) return { ok:false, error:'missing RESEND_API_KEY' };
  const resp = await fetch('https://api.resend.com/emails', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey}, body: JSON.stringify({ from:`${senderName} <${senderEmail}>`, to, subject, html }) });
  const ok = resp.ok; const data = await resp.text(); return { ok, data };
}
function renderTemplate(tpl, data){ return tpl.replace(/{{\s*(\w+)\s*}}/g, (_,k)=>(data[k]??'')); }
app.post('/api/notify', requireAdmin, async (req,res)=>{
  const { type, bookingId } = req.body;
  if(!type || !bookingId) return res.status(400).json({ error:'type & bookingId required' });
  const q = await pool.query(`SELECT b.*, c.name as client_name, c.email as client_email, c.phone as client_phone, s.name as service_name FROM booking b LEFT JOIN client c ON c.id=b.client_id LEFT JOIN service s ON s.id=b.service_id WHERE b.id=$1`, [bookingId]);
  if(!q.rowCount) return res.status(404).json({ error:'booking not found' });
  const b = q.rows[0];
  const tt = await pool.query('SELECT * FROM notification_template WHERE type=$1 AND salon_id=$2 LIMIT 1',[type,SALON_ID]);
  const tpl = tt.rowCount ? tt.rows[0] : { subject:'Le Mode', body:'Ciao {{name}}' };
  const data = { name:b.client_name, service:b.service_name, date:new Date(b.start_ts).toLocaleDateString('it-IT'), time:new Date(b.start_ts).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}) };
  let out = {}; if(type.endsWith('_email') && b.client_email){ out.email = await sendEmailResend(b.client_email, renderTemplate(tpl.subject||'Le Mode', data), '<p>'+renderTemplate(tpl.body||'', data)+'</p>'); }
  res.json({ ok:true, ...out });
});
app.listen(process.env.PORT||4000, ()=> console.log('API on '+(process.env.PORT||4000)));
