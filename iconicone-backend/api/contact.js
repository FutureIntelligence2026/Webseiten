// api/contact.js — Vercel Serverless Function
// POST /api/contact

import nodemailer from "nodemailer";
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "*").split(",");
  if (allowed.includes("*") || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, email, phone, firma, service, message } = req.body || {};

  // Pflichtfeld-Validierung
  if (!name || !email || !message) {
    return res.status(400).json({ error: "Pflichtfelder fehlen: name, email, message" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  // Anfrage in Vercel KV speichern
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    name,
    email,
    phone: phone || "",
    firma: firma || "",
    service: service || "",
    message,
    status: "neu",
    createdAt: new Date().toISOString(),
    readAt: null,
    doneAt: null,
  };

  await kv.hset("requests", { [id]: JSON.stringify(entry) });
  await kv.lpush("requests:index", id);

  // E-Mail-Config aus KV laden
  let emailConfig = null;
  try {
    const raw = await kv.get("email:config");
    if (raw) emailConfig = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {}

  if (emailConfig && emailConfig.host && emailConfig.user && emailConfig.pass) {
    const transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: parseInt(emailConfig.port || "465"),
      secure: emailConfig.secure !== false,
      auth: { user: emailConfig.user, pass: emailConfig.pass },
    });

    const notifyEmail = process.env.NOTIFY_EMAIL || emailConfig.user;
    const firmName = "ICONICONE";

    // Admin-Benachrichtigung
    const adminHtml = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><style>
  body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px}
  .card{background:#fff;border-radius:8px;max-width:580px;margin:auto;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  h2{color:#1a1a2e;margin-top:0}
  .badge{display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:3px 10px;font-size:13px;font-weight:600}
  table{width:100%;border-collapse:collapse;margin-top:20px}
  td{padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px}
  td:first-child{color:#666;width:140px;font-weight:600}
  .msg{background:#f9f9f9;border-left:3px solid #6c63ff;padding:12px 16px;margin-top:16px;border-radius:0 4px 4px 0;font-size:14px;line-height:1.6}
  .footer{margin-top:24px;font-size:12px;color:#aaa;text-align:center}
</style></head>
<body><div class="card">
  <h2>📬 Neue Anfrage <span class="badge">NEU</span></h2>
  <table>
    <tr><td>Name</td><td><strong>${name}</strong></td></tr>
    <tr><td>E-Mail</td><td><a href="mailto:${email}">${email}</a></td></tr>
    ${phone ? `<tr><td>Telefon</td><td>${phone}</td></tr>` : ""}
    ${firma ? `<tr><td>Firma</td><td>${firma}</td></tr>` : ""}
    ${service ? `<tr><td>Interesse</td><td>${service}</td></tr>` : ""}
    <tr><td>Eingegangen</td><td>${new Date().toLocaleString("de-DE")}</td></tr>
  </table>
  <div class="msg"><strong>Projektbeschreibung:</strong><br>${message.replace(/\n/g, "<br>")}</div>
  <div class="footer">${firmName} · Anfragen-System</div>
</div></body></html>`;

    // Bestätigungs-E-Mail an Kunden
    const confirmHtml = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><style>
  body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px}
  .card{background:#fff;border-radius:8px;max-width:560px;margin:auto;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  h2{color:#1a1a2e;margin-top:0}
  .hero{background:linear-gradient(135deg,#1a1a2e,#6c63ff);border-radius:8px;padding:24px;text-align:center;color:#fff;margin-bottom:24px}
  .hero h1{margin:0;font-size:20px}
  p{color:#444;line-height:1.7;font-size:15px}
  .summary{background:#f9f9f9;border-radius:6px;padding:16px;margin:16px 0;font-size:14px}
  .summary b{color:#333}
  .footer{margin-top:28px;font-size:12px;color:#aaa;text-align:center;border-top:1px solid #eee;padding-top:16px}
</style></head>
<body><div class="card">
  <div class="hero"><h1>✓ Ihre Anfrage ist eingegangen</h1></div>
  <p>Hallo <strong>${name}</strong>,</p>
  <p>vielen Dank für Ihre Anfrage! Wir haben Ihre Nachricht erhalten und melden uns so schnell wie möglich bei Ihnen.</p>
  <div class="summary">
    <b>Ihre Anfrage:</b><br><br>
    ${message.replace(/\n/g, "<br>")}
  </div>
  <p>Bei Fragen antworten Sie einfach auf diese E-Mail oder rufen uns an.</p>
  <p>Viele Grüße,<br><strong>Das ${firmName}-Team</strong></p>
  <div class="footer">${firmName} · Web-Agentur Bad Oeynhausen · Diese E-Mail wurde automatisch generiert.</div>
</div></body></html>`;

    try {
      await Promise.all([
        transporter.sendMail({
          from: `"${firmName}" <${emailConfig.user}>`,
          to: notifyEmail,
          subject: `📬 Neue Anfrage von ${name}`,
          html: adminHtml,
        }),
        transporter.sendMail({
          from: `"${firmName}" <${emailConfig.user}>`,
          to: email,
          subject: `✓ Ihre Anfrage bei ${firmName} ist eingegangen`,
          html: confirmHtml,
        }),
      ]);
    } catch (mailErr) {
      console.error("E-Mail Fehler:", mailErr.message);
    }
  }

  return res.status(200).json({
    success: true,
    message: "Anfrage erfolgreich gespeichert",
    id,
  });
}
