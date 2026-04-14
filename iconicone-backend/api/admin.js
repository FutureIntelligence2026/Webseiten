// api/admin.js — Vercel Serverless Function v2
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { kv } from "@vercel/kv";

const JWT_SECRET           = process.env.JWT_SECRET            || "change-me-min-32-chars";
const ADMIN_USER           = process.env.ADMIN_USERNAME        || "admin";
const ADMIN_PASS           = process.env.ADMIN_PASSWORD        || "changeme";
const BASE_URL             = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}` : (process.env.BASE_URL || "http://localhost:3000");
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

function cors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function verifyToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  try { return jwt.verify(auth.slice(7), JWT_SECRET); } catch { return null; }
}

async function getEmailConfig() {
  try {
    const raw = await kv.get("email:config");
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return null; }
}

function buildTransporter(config) {
  if (config.type === "google_oauth") {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        type:         "OAuth2",
        user:         config.user,
        clientId:     GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        refreshToken: config.refreshToken,
        accessToken:  config.accessToken,
      },
    });
  }
  return nodemailer.createTransport({
    host:   config.host,
    port:   parseInt(config.port || "465"),
    secure: config.secure !== false,
    auth:   { user: config.user, pass: config.pass },
    connectionTimeout: 8000,
    greetingTimeout:   5000,
  });
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(200).end();

  const url   = req.url.split("?")[0];
  const query = Object.fromEntries(new URL(req.url, "http://x").searchParams);

  // POST /api/admin/login
  if (url.endsWith("/login") && req.method === "POST") {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      return res.status(401).json({ error: "Ungültige Zugangsdaten" });
    }
    const token = jwt.sign({ user: username, role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token, expiresIn: 43200 });
  }

  // Auth-Check ab hier
  if (!verifyToken(req)) return res.status(401).json({ error: "Nicht autorisiert" });

  // GET /api/admin/requests
  if (url.endsWith("/requests") && req.method === "GET") {
    const { status, from, to, limit = "50", offset = "0" } = query;
    const ids = await kv.lrange("requests:index", 0, -1);
    if (!ids?.length) return res.json({ requests: [], total: 0 });

    const raw = await kv.hgetall("requests");
    let reqs  = ids.map(id => {
      const r = raw?.[id]; if (!r) return null;
      return typeof r === "string" ? JSON.parse(r) : r;
    }).filter(Boolean);

    if (status && status !== "alle") reqs = reqs.filter(r => r.status === status);
    if (from) { const d = new Date(from); reqs = reqs.filter(r => new Date(r.createdAt) >= d); }
    if (to)   { const d = new Date(to); d.setHours(23,59,59); reqs = reqs.filter(r => new Date(r.createdAt) <= d); }

    const total     = reqs.length;
    const paginated = reqs.slice(+offset, +offset + +limit);
    return res.json({ requests: paginated, total });
  }

  // PATCH /api/admin/requests
  if (url.endsWith("/requests") && req.method === "PATCH") {
    const { id, status } = req.body || {};
    if (!id || !["neu","gelesen","erledigt"].includes(status))
      return res.status(400).json({ error: "Ungültige Parameter" });

    const raw = await kv.hget("requests", id);
    if (!raw) return res.status(404).json({ error: "Nicht gefunden" });

    const entry  = typeof raw === "string" ? JSON.parse(raw) : raw;
    entry.status = status;
    if (status === "gelesen"  && !entry.readAt) entry.readAt = new Date().toISOString();
    if (status === "erledigt") entry.doneAt = new Date().toISOString();
    await kv.hset("requests", { [id]: JSON.stringify(entry) });
    return res.json({ success: true, request: entry });
  }

  // GET /api/admin/stats
  if (url.endsWith("/stats") && req.method === "GET") {
    const raw = await kv.hgetall("requests");
    const all = raw ? Object.values(raw).map(r => typeof r === "string" ? JSON.parse(r) : r) : [];
    const today = new Date().toISOString().slice(0, 10);
    return res.json({
      total:    all.length,
      neu:      all.filter(r => r.status === "neu").length,
      gelesen:  all.filter(r => r.status === "gelesen").length,
      erledigt: all.filter(r => r.status === "erledigt").length,
      heute:    all.filter(r => r.createdAt?.startsWith(today)).length,
      last7days: Array.from({ length: 7 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (6 - i));
        const ds = d.toISOString().slice(0, 10);
        return { date: ds, count: all.filter(r => r.createdAt?.startsWith(ds)).length };
      }),
    });
  }

  // GET /api/admin/email-config
  if (url.endsWith("/email-config") && req.method === "GET") {
    const config = await getEmailConfig();
    if (!config) return res.json({ configured: false });
    return res.json({
      configured: true,
      type:       config.type || "smtp",
      provider:   config.provider || "custom",
      user:       config.user,
      host:       config.host || "",
      port:       config.port || 465,
      secure:     config.secure !== false,
      updatedAt:  config.updatedAt || null,
    });
  }

  // POST /api/admin/email-config — SMTP speichern
  if (url.endsWith("/email-config") && req.method === "POST") {
    const { host, port, secure, user, pass, provider } = req.body || {};
    if (!user) return res.status(400).json({ error: "E-Mail-Adresse fehlt" });
    if (!pass) return res.status(400).json({ error: "Passwort fehlt" });
    if (!host) return res.status(400).json({ error: "SMTP-Host fehlt" });

    const testTransporter = nodemailer.createTransport({
      host, port: parseInt(port || "465"), secure: secure !== false,
      auth: { user, pass }, connectionTimeout: 8000, greetingTimeout: 5000,
    });
    try {
      await testTransporter.verify();
    } catch (err) {
      return res.status(400).json({
        error: `Verbindung fehlgeschlagen: ${err.message}`,
        hint: "SMTP-Host, Port, E-Mail und Passwort prüfen. Bei Gmail: App-Passwort verwenden.",
      });
    }

    const config = {
      type: "smtp", provider: provider || "custom",
      host, port: parseInt(port || "465"), secure: secure !== false,
      user, pass, updatedAt: new Date().toISOString(),
    };
    await kv.set("email:config", JSON.stringify(config));
    return res.json({ success: true, message: "Verbindung erfolgreich gespeichert ✓" });
  }

  // DELETE /api/admin/email-config
  if (url.endsWith("/email-config") && req.method === "DELETE") {
    await kv.del("email:config");
    return res.json({ success: true, message: "E-Mail-Verbindung getrennt" });
  }

  // POST /api/admin/email-test
  if (url.endsWith("/email-test") && req.method === "POST") {
    const config = await getEmailConfig();
    if (!config) return res.status(400).json({ error: "Keine E-Mail konfiguriert" });

    const transporter = buildTransporter(config);
    try {
      await transporter.sendMail({
        from:    `"ICONICONE Test" <${config.user}>`,
        to:      config.user,
        subject: "✓ Test-E-Mail — ICONICONE Backend funktioniert!",
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#fff">
          <h2 style="color:#22c55e;margin-top:0">✓ Verbindung funktioniert!</h2>
          <p>Deine E-Mail-Konfiguration für ICONICONE ist korrekt eingerichtet. Anfragen werden ab sofort automatisch weitergeleitet.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
            <tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Anbieter</td><td style="padding:10px;font-weight:600">${config.provider}</td></tr>
            <tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">Typ</td><td style="padding:10px;font-weight:600">${config.type === "google_oauth" ? "Google OAuth" : "SMTP"}</td></tr>
            <tr style="border-bottom:1px solid #eee"><td style="padding:10px;color:#666">E-Mail</td><td style="padding:10px;font-weight:600">${config.user}</td></tr>
            ${config.host ? `<tr><td style="padding:10px;color:#666">Server</td><td style="padding:10px;font-weight:600">${config.host}:${config.port}</td></tr>` : ""}
          </table>
          <p style="color:#888;font-size:13px">Gesendet: ${new Date().toLocaleString("de-DE")}</p>
        </div>`,
      });
      return res.json({ success: true, message: "Test-E-Mail gesendet! Bitte Posteingang prüfen." });
    } catch (err) {
      return res.status(500).json({ error: "Sendefehler: " + err.message });
    }
  }

  // GET /api/admin/google-auth-url
  if (url.endsWith("/google-auth-url") && req.method === "GET") {
    if (!GOOGLE_CLIENT_ID) return res.status(400).json({
      error: "Google OAuth nicht konfiguriert.",
      hint: "GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET als Vercel ENV setzen.",
      docs: "https://console.cloud.google.com/apis/credentials",
    });
    const redirectUri = `${BASE_URL}/api/admin/google-callback`;
    const scope       = encodeURIComponent("https://mail.google.com/");
    const authUrl     = `https://accounts.google.com/o/oauth2/v2/auth`
      + `?client_id=${GOOGLE_CLIENT_ID}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
    return res.json({ url: authUrl });
  }

  // GET /api/admin/google-callback
  if (url.endsWith("/google-callback") && req.method === "GET") {
    const { code, error: oauthError } = query;
    if (oauthError || !code)
      return res.redirect(`/dashboard.html?email_error=${encodeURIComponent(oauthError || "no_code")}`);

    const redirectUri = `${BASE_URL}/api/admin/google-callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error)
      return res.redirect(`/dashboard.html?email_error=${encodeURIComponent(tokens.error_description || tokens.error)}`);

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileRes.json();

    const config = {
      type: "google_oauth", provider: "gmail", user: profile.email,
      refreshToken: tokens.refresh_token, accessToken: tokens.access_token,
      updatedAt: new Date().toISOString(),
    };
    await kv.set("email:config", JSON.stringify(config));
    return res.redirect("/dashboard.html?email_success=google");
  }

  return res.status(404).json({ error: "Route nicht gefunden" });
}
