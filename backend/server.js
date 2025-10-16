import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ====== DB POOL (SSL) ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ====== COSTANTI ======
const SALON_ID = "00000000-0000-0000-0000-000000000001";

// ====== HELPER ORARI ======
function toDate(dateStr, hh, mm) {
  // data in UTC per evitare problemi fuso
  return new Date(
    `${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(
      2,
      "0"
    )}:00.000Z`
  );
}
function addMinutes(d, m) {
  return new Date(d.getTime() + m * 60000);
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ====== HEALTH ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ====== SERVICES ======
app.get("/api/services", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM service WHERE salon_id=$1 ORDER BY category, name",
      [SALON_ID]
    );
    res.json(rows);
  } catch (e) {
    console.error("ERR /api/services", e);
    res
      .status(500)
      .json({ error: "services_failed", message: String(e?.message || e) });
  }
});

// ====== STAFF (robusto con fallback) ======
app.get("/api/staff", async (req, res) => {
  try {
    // Primo tentativo: filtro active=TRUE (se la colonna esiste)
    try {
      const { rows } = await pool.query(
        "SELECT id, name, role, COALESCE(active, TRUE) AS active FROM staff WHERE salon_id=$1 AND COALESCE(active, TRUE)=TRUE ORDER BY name",
        [SALON_ID]
      );
      return res.json(rows);
    } catch (inner) {
      console.warn(
        "WARN /api/staff: fallback senza filtro active →",
        inner?.message || inner
      );
      // Fallback: senza filtro active
      const { rows } = await pool.query(
        "SELECT id, name, role FROM staff WHERE salon_id=$1 ORDER BY name",
        [SALON_ID]
      );
      return res.json(rows);
    }
  } catch (e) {
    console.error("ERR /api/staff", e);
    return res
      .status(500)
      .json({ error: "staff_failed", message: String(e?.message || e) });
  }
});

// ====== DEBUG STAFF (diagnostica) ======
app.get("/api/debug/staff", async (req, res) => {
  try {
    const info = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='staff' ORDER BY ordinal_position"
    );
    const sample = await pool.query(
      "SELECT * FROM staff WHERE salon_id=$1 LIMIT 1",
      [SALON_ID]
    );
    res.json({ ok: true, columns: info.rows, sample: sample.rows });
  } catch (e) {
    console.error("ERR /api/debug/staff", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== RESOLVER ID (accetta UUID o indici numerici) ======
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveServiceId(input) {
  if (UUID_RE.test(String(input))) return String(input);
  if (/^\d+$/.test(String(input))) {
    const { rows } = await pool.query(
      "SELECT id FROM service WHERE salon_id=$1 ORDER BY category, name",
      [SALON_ID]
    );
    const idx = parseInt(input, 10) - 1;
    if (rows[idx]) return rows[idx].id;
    throw new Error("service_index_out_of_range");
  }
  throw new Error("invalid_service_id");
}

async function resolveStaffId(input) {
  if (UUID_RE.test(String(input))) return String(input);
  if (/^\d+$/.test(String(input))) {
    const { rows } = await pool.query(
      "SELECT id FROM staff WHERE salon_id=$1 AND COALESCE(active, TRUE)=TRUE ORDER BY name",
      [SALON_ID]
    );
    const idx = parseInt(input, 10) - 1;
    if (rows[idx]) return rows[idx].id;
    throw new Error("staff_index_out_of_range");
  }
  throw new Error("invalid_staff_id");
}

// ====== AVAILABILITY ======
// GET /api/availability?service_id=...&staff_id=...&date=YYYY-MM-DD
app.get("/api/availability", async (req, res) => {
  try {
    const { service_id: rawServiceId, staff_id: rawStaffId, date } = req.query;
    if (!rawServiceId || !rawStaffId || !date) {
      return res.status(400).json({
        error: "missing_params",
        message: "service_id, staff_id, date sono obbligatori (YYYY-MM-DD)",
      });
    }

    const service_id = await resolveServiceId(rawServiceId);
    const staff_id = await resolveStaffId(rawStaffId);

    // durata servizio
    const svc = await pool.query(
      "SELECT duration_min FROM service WHERE id=$1 AND salon_id=$2",
      [service_id, SALON_ID]
    );
    if (svc.rowCount === 0) {
      return res.status(404).json({ error: "service_not_found" });
    }
    const duration = Number(svc.rows[0].duration_min) || 30;

    // fascia lavorativa 09:00–19:00
    const dayStart = toDate(date, 9, 0);
    const dayEnd = toDate(date, 19, 0);

    // prenotazioni esistenti
    const busy = await pool.query(
      `SELECT start_ts, end_ts
       FROM booking
       WHERE salon_id=$1
         AND staff_id=$2
         AND start_ts >= $3 AND start_ts < $4
         AND status NOT IN ('cancelled','no_show')`,
      [SALON_ID, staff_id, dayStart, dayEnd]
    );
    const busyRanges = busy.rows.map((r) => [
      new Date(r.start_ts),
      new Date(r.end_ts),
    ]);

    // genera slot
    const step = 30;
    const slots = [];
    for (
      let t = new Date(dayStart);
      addMinutes(t, duration) <= dayEnd;
      t = addMinutes(t, step)
    ) {
      const slotStart = new Date(t);
      const slotEnd = addMinutes(slotStart, duration);
      const clash = busyRanges.some(([bS, bE]) =>
        overlaps(slotStart, slotEnd, bS, bE)
      );
      if (!clash) {
        slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
      }
    }

    return res.json({ date, service_id, staff_id, duration_min: duration, slots });
  } catch (e) {
    console.error("ERR /api/availability", e);
    return res
      .status(500)
      .json({ error: "availability_failed", message: String(e?.message || e) });
  }
});

// ====== BOOKINGS ======
// POST /api/bookings { client_name, client_phone, service_id, staff_id, start_ts }
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      client_name,
      client_phone,
      service_id: rawServiceId,
      staff_id: rawStaffId,
      start_ts,
    } = req.body || {};

    if (!client_name || !rawServiceId || !rawStaffId || !start_ts) {
      return res.status(400).json({
        error: "missing_params",
        message:
          "client_name, service_id, staff_id, start_ts sono obbligatori",
      });
    }

    const service_id = await resolveServiceId(rawServiceId);
    const staff_id = await resolveStaffId(rawStaffId);

    // durata servizio
    const svc = await pool.query(
      "SELECT duration_min FROM service WHERE id=$1 AND salon_id=$2",
      [service_id, SALON_ID]
    );
    if (svc.rowCount === 0)
      return res.status(404).json({ error: "service_not_found" });
    const duration = Number(svc.rows[0].duration_min) || 30;

    const start = new Date(start_ts);
    const end = new Date(start.getTime() + duration * 60000);

    // trova o crea cliente
    let clientId;
    if (client_phone) {
      const found = await pool.query(
        "SELECT id FROM client WHERE salon_id=$1 AND phone=$2 LIMIT 1",
        [SALON_ID, client_phone]
      );
      if (found.rowCount > 0) clientId = found.rows[0].id;
    }
    if (!clientId) {
      const created = await pool.query(
        "INSERT INTO client (salon_id, name, phone) VALUES ($1,$2,$3) RETURNING id",
        [SALON_ID, client_name, client_phone || null]
      );
      clientId = created.rows[0].id;
    }

    // controllo sovrapposizioni
    const overlap = await pool.query(
      `SELECT 1 FROM booking
       WHERE salon_id=$1 AND staff_id=$2
         AND status NOT IN ('cancelled','no_show')
         AND start_ts < $4 AND end_ts > $3
       LIMIT 1`,
      [SALON_ID, staff_id, start, end]
    );
    if (overlap.rowCount > 0) {
      return res.status(409).json({
        error: "slot_taken",
        message: "Lo slot selezionato non è più disponibile. Aggiorna gli orari.",
      });
    }

    // crea prenotazione
    const ins = await pool.query(
      `INSERT INTO booking (salon_id, client_id, staff_id, service_id, start_ts, end_ts, status)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed')
       RETURNING id`,
      [SALON_ID, clientId, staff_id, service_id, start, end]
    );

    return res.status(201).json({ ok: true, booking_id: ins.rows[0].id });
  } catch (e) {
    console.error("ERR /api/bookings", e);
    return res
      .status(500)
      .json({ error: "booking_failed", message: String(e?.message || e) });
  }
});

// ====== DEBUG DB ======
app.get("/api/debug/db", async (req, res) => {
  try {
    const ping = await pool.query(
      "SELECT NOW() as now, (SELECT COUNT(*) FROM service WHERE salon_id=$1) as services, (SELECT COUNT(*) FROM staff WHERE salon_id=$1) as staff",
      [SALON_ID]
    );
    res.json({ ok: true, ...ping.rows[0] });
  } catch (e) {
    console.error("ERR /api/debug/db", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== ERROR HANDLER ======
app.use((err, req, res, next) => {
  console.error("UNCAUGHT", err);
  res
    .status(500)
    .json({ error: "internal_error", message: String(err?.message || err) });
});

// ====== START ======
app.listen(port, () => {
  console.log(`API on ${port}`);
});
