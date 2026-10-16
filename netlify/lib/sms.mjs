// Texting through Twilio's REST API. Credentials live only in Netlify env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
//   TWILIO_MESSAGING_SERVICE_SID (recommended, tied to your 10DLC campaign) or TWILIO_FROM (+15551234567).
import { HttpError } from "./store.mjs";

export function smsConfigured() {
  const e = process.env;
  return !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_MESSAGING_SERVICE_SID || e.TWILIO_FROM));
}

// US-centric: 10 digits -> +1XXXXXXXXXX; 11 starting with 1 -> +1...; already +E.164 kept.
export function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 ? "+" + d : "";
  }
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

export const prettyPhone = (e164) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || "";
};

export async function sendSms(to, body) {
  if (!smsConfigured()) throw new HttpError(503, "Texting isn't set up: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM) in Netlify.");
  const e = process.env;
  const form = new URLSearchParams({ To: to, Body: body });
  if (e.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", e.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", e.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(e.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = data.code === 21610 ? " (this number has replied STOP)" : data.code === 21211 ? " (invalid phone number)" : "";
    throw new Error(`Twilio ${data.code || res.status}: ${data.message || "send failed"}${hint}`);
  }
  return { sid: data.sid, status: data.status };
}

// "{name}", "{first}", "{numbers}", "{count}", "{event}" placeholders.
export function renderTemplate(tpl, v) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)).slice(0, 1200);
}
