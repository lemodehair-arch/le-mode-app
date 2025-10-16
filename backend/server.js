// ============================
// LE MODE BACKEND v10
// ============================

import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
const port = process.env.PORT || 10000;

// Middleware base
app.use(cors());
app.use(express.json());

// Connessione al database Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // forza SSL richiesto da Supabase
});

// ============================
// ENDPOINT DI SALUTE
// ============================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ============================
// ENDPOINT: SERVIZI
// ============================
app.get("/api/services", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM service ORDER BY category, name"
    );
    res.json(rows);
  } catch (e) {
    console.error("ERR /api/services", e);
    res
      .status(500)
      .json({ error: "services_failed", message: String(e?.message || e) });
  }
});

// ============================
// ENDPOINT: STAFF
// ============================
// 🔹 Endpoint staff (robusto: tenta con active=TRUE e, se fallisce, fa fallback)
app.get("/api/staff", async (req, res) => {
  try {
    // Primo tentativo: colonna "active" presente
    try {
      const { rows } = await pool.query(
        "SELECT id, name, role, COALESCE(active, TRUE) AS active FROM staff WHERE COALESCE(active, TRUE)=TRUE ORDER BY name"
      );
      return res.json(rows);
    } catch (inner) {
      console.warn("WARN /api/staff: fallback senza filtro active →", inner?.message || inner);
      // Fallback: nessun filtro (se la colonna non esiste o dà problemi)
      const { rows } = await pool.query(
        "SELECT id, name, role FROM staff ORDER BY name"
      );
      return res.json(rows);
    }
  } catch (e) {
    console.error("ERR /api/staff", e);
    return res.status(500).json({
      error: "staff_failed",
      message: String(e?.message || e),
    });
  }
});
  try {
    const { rows } = await pool.query(
      "SELECT * FROM staff WHERE active=TRUE ORDER BY name"
    );
    res.json(rows);
  } catch (e) {
    console.error("ERR /api/staff", e);
    res
      .status(500)
      .json({ error: "staff_failed", message: String(e?.message || e) });
  }
});
// 🔹 Debug staff: mostra le colonne presenti e il primo record
app.get("/api/debug/staff", async (req, res) => {
  try {
    const info = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='staff' ORDER BY ordinal_position"
    );
    const sample = await pool.query("SELECT * FROM staff LIMIT 1");
    res.json({
      ok: true,
      columns: info.rows,
      sample: sample.rows,
    });
  } catch (e) {
    console.error("ERR /api/debug/staff", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});// ============================
// ENDPOINT: DEBUG CONNESSIONE DB
// ============================
app.get("/api/debug/db", async (req, res) => {
  try {
    const ping = await pool.query(
      "SELECT NOW() as now, (SELECT COUNT(*) FROM service) as services, (SELECT COUNT(*) FROM staff) as staff"
    );
    res.json({ ok: true, ...ping.rows[0] });
  } catch (e) {
    console.error("ERR /api/debug/db", e);
    res
      .status(500)
      .json({ ok: false, error: String(e?.message || e) });
  }
});
// ====== CONFIG SALONE (Le Mode) ======
const SALON_ID = '00000000-0000-0000-0000-000000000001';

// ====== UTILI ORARI DI LAVORO (semplice MVP) ======
// Giorno lavorativo 09:00–19:00, slot da 30 minuti
function toDate(dateStr, hh, mm) {
  // Crea una data in UTC per evitare problemi di fuso nel calcolo
  return new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
}
function addMinutes(d, m) { return new Date(d.getTime() + m*60000); }
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ====== GET /api/availability ======
// Query params richiesti: service_id, staff_id, date (YYYY-MM-DD)
app.get('/api/availability', async (req, res) => {
  try {
    const { service_id, staff_id, date } = req.query;
    if (!service_id || !staff_id || !date) {
      return res.status(400).json({ error: 'missing_params', message: 'service_id, staff_id, date sono obbligatori (YYYY-MM-DD)' });
    }

    // 1) durata servizio
    const svc = await pool.query(
      'SELECT duration_min FROM service WHERE id = $1 AND salon_id = $2',
      [service_id, SALON_ID]
    );
    if (svc.rowCount === 0) {
      return res.status(404).json({ error: 'service_not_found' });
    }
    const duration = Number(svc.rows[0].duration_min) || 30;

    // 2) prenotazioni esistenti in quel giorno per lo staff
    const dayStart = toDate(date, 9, 0);
    const dayEnd   = toDate(date, 19, 0);
    const busy = await pool.query(
      `SELECT start_ts, end_ts
       FROM booking
       WHERE salon_id = $1
         AND staff_id = $2
         AND start_ts >= $3 AND start_ts < $4
         AND status NOT IN ('cancelled','no_show')`,
      [SALON_ID, staff_id, dayStart, dayEnd]
    );
    const busyRanges = busy.rows.map(r => [new Date(r.start_ts), new Date(r.end_ts)]);

    // 3) genera slot ogni 30 min e filtra quelli che non si sovrappongono
    const step = 30; // minuti tra gli slot
    const slots = [];
    for (let t = new Date(dayStart); addMinutes(t, duration) <= dayEnd; t = addMinutes(t, step)) {
      const slotStart = new Date(t);
      const slotEnd = addMinutes(slotStart, duration);
      const clash = busyRanges.some(([bS, bE]) => overlaps(slotStart, slotEnd, bS, bE));
      if (!clash) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString()
        });
      }
    }

    return res.json({ date, service_id, staff_id, duration_min: duration, slots });
  } catch (e) {
    console.error('ERR /api/availability', e);
    return res.status(500).json({ error: 'availability_failed', message: String(e?.message || e) });
  }
});

// ====== POST /api/bookings ======
// Body JSON: { client_name, client_phone, service_id, staff_id, start_ts }
// start_ts in ISO (es: "2025-10-17T14:30:00.000Z")
app.post('/api/bookings', async (req, res) => {
  try {
    const { client_name, client_phone, service_id, staff_id, start_ts } = req.body || {};
    if (!client_name || !service_id || !staff_id || !start_ts) {
      return res.status(400).json({ error: 'missing_params', message: 'client_name, service_id, staff_id, start_ts sono obbligatori' });
    }

    // durata servizio
    const svc = await pool.query(
      'SELECT duration_min FROM service WHERE id = $1 AND salon_id = $2',
      [service_id, SALON_ID]
    );
    if (svc.rowCount === 0) return res.status(404).json({ error: 'service_not_found' });
    const duration = Number(svc.rows[0].duration_min) || 30;

    const start = new Date(start_ts);
    const end = new Date(start.getTime() + duration * 60000);

    // trova o crea cliente
    let clientId;
    if (client_phone) {
      const found = await pool.query(
        'SELECT id FROM client WHERE salon_id = $1 AND phone = $2 LIMIT 1',
        [SALON_ID, client_phone]
      );
      if (found.rowCount > 0) {
        clientId = found.rows[0].id;
      }
    }
    if (!clientId) {
      const created = await pool.query(
        'INSERT INTO client (salon_id, name, phone) VALUES ($1,$2,$3) RETURNING id',
        [SALON_ID, client_name, client_phone || null]
      );
      clientId = created.rows[0].id;
    }

    // controlla sovrapposizioni (concorrenza)
    const overlap = await pool.query(
      `SELECT 1 FROM booking
       WHERE salon_id = $1 AND staff_id = $2
         AND status NOT IN ('cancelled','no_show')
         AND start_ts < $4 AND end_ts > $3
       LIMIT 1`,
      [SALON_ID, staff_id, start, end]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({ error: 'slot_taken', message: 'Lo slot selezionato non è più disponibile. Aggiorna gli orari.' });
    }

    // crea prenotazione
    const ins = await pool.query(
      `INSERT INTO booking (salon_id, client_id, staff_id, service_id, start_ts, end_ts, status)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed')
       RETURNING id`,
      [SALON_ID, clientId, service_id, start, end]
    );

    return res.status(201).json({ ok: true, booking_id: ins.rows[0].id });
  } catch (e) {
    console.error('ERR /api/bookings', e);
    return res.status(500).json({ error: 'booking_failed', message: String(e?.message || e) });
  }
});// ============================
// ERROR HANDLER GLOBALE
// ============================
app.use((err, req, res, next) => {
  console.error("UNCAUGHT", err);
  res
    .status(500)
    .json({ error: "internal_error", message: String(err?.message || err) });
});

// ============================
// AVVIO SERVER
// ============================
app.listen(port, () => {
  console.log(`API on ${port}`);
});
