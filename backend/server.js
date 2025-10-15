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
app.get("/api/staff", async (req, res) => {
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

// ============================
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

// ============================
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
