'use strict';
// Voice calls for fire alerts. Same idea as the SMS sender in alerts.js: it works with no keys at all
// (it prints "[DEMO CALL]" to the terminal), and a real provider is switched on from .env.
//
//   CALL_PROVIDER=twilio    needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a Twilio voice number, +E.164)
//   CALL_PROVIDER=webhook   needs CALL_WEBHOOK_URL (and optionally CALL_WEBHOOK_TOKEN). The server POSTs
//                           { to, message, device_id, level } as JSON; use it to plug in Exotel, MCube, Knowlarity,
//                           a Zapier/n8n flow, or any other voice service that has an HTTP endpoint.
//   (not set)               automatic: twilio if its three keys exist, else webhook if its URL exists, else demo.
//
// Numbers are given as 10-digit Indian mobiles (the same form alerts.js stores) and sent on as +91XXXXXXXXXX.
// The spoken text is always built by the server (see calls.js); nothing from a request body is ever read aloud.
const deps = {};                                  // tests replace deps.placeCall(number, message, ctx)

const VOICE = () => process.env.CALL_VOICE || 'Polly.Aditi';       // Indian-English voice on Twilio
const LANG = () => process.env.CALL_LANGUAGE || 'en-IN';
const maskNumber = n => '******' + String(n).slice(-4);
const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function provider() {
  if (process.env.DEMO_OUTPUT === '1') return 'demo';             // print every call in the terminal, never place a real one
  const want = String(process.env.CALL_PROVIDER || '').trim().toLowerCase();
  const twilioReady = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  const hookReady = !!process.env.CALL_WEBHOOK_URL;
  if (want === 'twilio') return twilioReady ? 'twilio' : 'demo';
  if (want === 'webhook') return hookReady ? 'webhook' : 'demo';
  if (want === 'demo' || want === 'off') return 'demo';
  return twilioReady ? 'twilio' : hookReady ? 'webhook' : 'demo';
}

function statusLine() {
  if (process.env.DEMO_OUTPUT === '1') return 'DEMO_OUTPUT=1: verification codes, SMS, emails and calls are PRINTED in this terminal, nothing real is sent';
  const p = provider();
  const want = String(process.env.CALL_PROVIDER || '').trim().toLowerCase();
  if (p === 'demo' && (want === 'twilio' || want === 'webhook'))
    return 'Fire calls: provider "' + want + '" is NOT set up (missing keys), so calls only print to the terminal';
  return 'Fire calls: ' + (p === 'demo' ? 'DEMO (printed to the terminal, no real calls)' : p);
}

// ---- Twilio: POST /Calls with the spoken text sent inline as TwiML (no public URL needed) ----
async function twilioCall(number, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  const say = t => `<Say voice="${esc(VOICE())}" language="${esc(LANG())}">${esc(t)}</Say>`;
  const twiml = '<Response>' + say(message) + '<Pause length="2"/>' + say('I repeat. ' + message) + '</Response>';
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: '+91' + number, From: process.env.TWILIO_FROM, Twiml: twiml, Timeout: '30' }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));       // only the numeric Twilio code is kept; the text can contain phone numbers
    throw new Error('Twilio refused the call: HTTP ' + res.status + (body.code ? ' (code ' + body.code + ')' : ''));
  }
}

// ---- generic webhook ----
async function webhookCall(number, message, ctx) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.CALL_WEBHOOK_TOKEN) headers.authorization = 'Bearer ' + process.env.CALL_WEBHOOK_TOKEN;
  const res = await fetch(process.env.CALL_WEBHOOK_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ to: '+91' + number, message, device_id: ctx.device_id || null, level: ctx.level || null }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('The call webhook refused the call: HTTP ' + res.status);
}

async function callOne(number, message, ctx) {
  if (deps.placeCall) return deps.placeCall(number, message, ctx);
  const p = provider();
  if (p === 'twilio') return twilioCall(number, message);
  if (p === 'webhook') return webhookCall(number, message, ctx);
  console.log('\n[DEMO CALL] to ' + number + '\n  Voice says: ' + message + '\n');
}

// Calls every number (5 at a time). One failure never stops the others.
// ctx: { device_id, level } is passed on to the provider. Returns { placed, failed, errors, mode }.
async function placeCalls(numbers, message, ctx = {}) {
  const out = { placed: 0, failed: 0, errors: [], mode: deps.placeCall ? 'test' : provider() };
  const list = [...new Set(numbers)];
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const results = await Promise.allSettled(chunk.map(n => callOne(n, message, ctx)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') out.placed++;
      else { out.failed++; out.errors.push(maskNumber(chunk[k]) + ': ' + String(r.reason && r.reason.message || r.reason).slice(0, 120)); }
    });
  }
  return out;
}

module.exports = { placeCalls, provider, statusLine, maskNumber, deps };
