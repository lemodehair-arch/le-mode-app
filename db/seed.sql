-- seed.sql
INSERT INTO salon (id, name) VALUES ('00000000-0000-0000-0000-000000000001','Le Mode');
INSERT INTO staff (id, salon_id, name, role, color_hex, skills) VALUES
('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','Elisa','Hair Stylist','#FF6AA6','{capelli, colore, piega}'),
('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000001','Sara','Estetista','#6AA6FF','{manicure, pedicure, ceretta}'),
('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000001','Marco','Barber','#7CD992','{uomo, barba}'),
('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000001','Davide','Hair Stylist','#F4B400','{capelli, piega, taglio}');
INSERT INTO service (salon_id, name, category, duration_min, price_eur, requires_deposit) VALUES
('00000000-0000-0000-0000-000000000001','Taglio Donna','Capelli',45,35,false),
('00000000-0000-0000-0000-000000000001','Colore','Capelli',60,45,false),
('00000000-0000-0000-0000-000000000001','Piega','Capelli',30,20,false),
('00000000-0000-0000-0000-000000000001','Manicure','Estetica',30,18,false);
INSERT INTO staff_schedule (staff_id, weekday, start_time, end_time)
SELECT id, wd, '09:00','18:00' FROM staff, LATERAL (VALUES (1),(2),(3),(4),(5),(6)) v(wd);
INSERT INTO notification_template (salon_id, type, subject, body) VALUES
('00000000-0000-0000-0000-000000000001','confirm_email','Conferma prenotazione {{service}}','Ciao {{name}}, la tua prenotazione per {{service}} del {{date}} alle {{time}} è confermata. A presto, Le Mode.'),
('00000000-0000-0000-0000-000000000001','reminder_email','Promemoria prenotazione {{service}}','Ciao {{name}}, ti ricordiamo l\'appuntamento domani alle {{time}} per {{service}}.'),
('00000000-0000-0000-0000-000000000001','noshow_email','Appuntamento mancato','Ciao {{name}}, non ti abbiamo trovato all\'appuntamento del {{date}}.');
