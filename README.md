# Le Mode — MVP (graphics refresh)
- PWA frontend (index/admin) con tema, icone e griglia agenda.
- Backend Node/Express + Postgres con API per clienti/staff/servizi/prenotazioni.
- Tab **Staff** per rinominare/aggiungere/disattivare operatori (sì, i nomi sono sostituibili).
- Notifiche email via Resend (imposta RESEND_API_KEY).

## Setup rapido
1) DB (Supabase): esegui db/schema.sql e db/seed.sql
2) Backend:
   cd backend
   cp .env.example .env  # inserisci DATABASE_URL + ADMIN_TOKEN (+ RESEND_API_KEY)
   npm install
   npm run dev
3) Frontend:
   cd frontend
   npx serve .
4) Configura API URL in pagina (es. http://localhost:4000/api). Aggiungi alla Home su iPhone.
