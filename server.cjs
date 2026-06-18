try { require('dotenv').config(); } catch (_) {}
const seoBridge = require('./seoBridge.cjs');
const express = require('express');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const https = require('https');
const cron = require('node-cron');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || 'price_1TjKLORJECiV6vSmYVK4HnNu';
const PRICE_LIFETIME = process.env.STRIPE_PRICE_LIFETIME || 'price_1TjKLQRJECiV6vSmfnlDzmLg';
const APP_URL = process.env.APP_URL || 'https://steuercockpit-production.up.railway.app';

if (!STRIPE_KEY) { console.error('FATAL: STRIPE_SECRET_KEY not set'); process.exit(1); }

const stripe = Stripe(STRIPE_KEY);
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const app = express();

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const body = JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', e => console.error('Telegram:', e.message));
  req.write(body); req.end();
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Body Parsing — skip JSON for webhook ────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/webhook') return next();
  express.json()(req, res, next);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'steuercockpit',
  stripe: !!STRIPE_KEY,
  claude: !!ANTHROPIC_KEY,
  telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
  plans: { monthly: PRICE_MONTHLY, lifetime: PRICE_LIFETIME },
  timestamp: new Date().toISOString()
}));

// ── Checkout ──────────────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!plan || !['monthly', 'lifetime'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be "monthly" or "lifetime"' });
    }
    const isLifetime = plan === 'lifetime';
    const session = await stripe.checkout.sessions.create({
      mode: isLifetime ? 'payment' : 'subscription',
      line_items: [{ price: isLifetime ? PRICE_LIFETIME : PRICE_MONTHLY, quantity: 1 }],
      success_url: `${APP_URL}?success=true&plan=${plan}`,
      cancel_url: `${APP_URL}?cancelled=true`,
      allow_promotion_codes: true,
      ...(isLifetime ? {} : { subscription_data: { trial_period_days: 14, metadata: { plan, source: 'steuercockpit' } } }),
      metadata: { plan, source: 'steuercockpit' }
    });
    console.log(`Checkout: plan=${plan} session=${session.id}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Classify ───────────────────────────────────────────────────────────────
app.post('/api/classify', async (req, res) => {
  const { text, type } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!anthropic) return res.status(503).json({ error: 'Claude not configured' });

  try {
    const typeHint = type === 'rechnung' ? 'Rechnung/Invoice' : 'Abonnement/Subscription';
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Klassifiziere dieses ${typeHint} auf Deutsch. Antworte NUR als JSON ohne Markdown.
Text: "${text}"
Schema: {"category":"string","decision":"Behalten|Kündigen|Prüfen","businessRelevant":bool,"taxDeductible":bool,"confidence":0.0-1.0,"reason":"string"}`
      }]
    });
    const raw = msg.content[0].text.trim();
    const parsed = JSON.parse(raw.replace(/```json?|```/g, '').trim());
    res.json(parsed);
  } catch (err) {
    console.error('Classify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Revenue ───────────────────────────────────────────────────────────────────
app.get('/api/revenue', async (_req, res) => {
  try {
    const monthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
    const [subs, invoices] = await Promise.all([
      stripe.subscriptions.list({ status: 'active', limit: 100 }),
      stripe.invoices.list({ status: 'paid', created: { gte: monthStart }, limit: 100 })
    ]);
    const mrr = subs.data.reduce((s, sub) => {
      const p = sub.items?.data?.[0]?.price;
      if (!p) return s;
      return s + (p.unit_amount / 100) / (p.recurring?.interval === 'year' ? 12 : 1);
    }, 0);
    const monthRevenue = invoices.data.reduce((s, i) => s + (i.amount_paid || 0) / 100, 0);
    res.json({ activeSubs: subs.data.length, mrr: mrr.toFixed(2), monthRevenue: monthRevenue.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email Marketing: Klaviyo + Mailchimp subscriber on purchase ───────────────
async function subscribeToMarketing(email, plan, source) {
  const klaviyoKey = process.env.KLAVIYO_API_KEY;
  const klaviyoList = process.env.KLAVIYO_LIST_ID;
  const mailchimpKey = process.env.MAILCHIMP_API_KEY;
  const mailchimpServer = process.env.MAILCHIMP_SERVER_PREFIX || 'us7';
  const mailchimpList = process.env.MAILCHIMP_LIST_ID;

  // Klaviyo
  if (klaviyoKey) {
    fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: { 'Authorization': `Klaviyo-API-Key ${klaviyoKey}`, 'revision': '2024-10-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { type: 'profile', attributes: { email, properties: { plan, source, purchased: true } } } })
    }).then(async r => {
      if (klaviyoList && r.status !== 400) {
        const pid = (await r.json()).data?.id;
        if (pid) fetch(`https://a.klaviyo.com/api/lists/${klaviyoList}/relationships/profiles/`, {
          method: 'POST',
          headers: { 'Authorization': `Klaviyo-API-Key ${klaviyoKey}`, 'revision': '2024-10-15', 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [{ type: 'profile', id: pid }] })
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  // Mailchimp
  if (mailchimpKey && mailchimpList) {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
    fetch(`https://${mailchimpServer}.api.mailchimp.com/3.0/lists/${mailchimpList}/members/${hash}`, {
      method: 'PUT',
      headers: { 'Authorization': `Basic ${Buffer.from(`anystring:${mailchimpKey}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', status: 'subscribed', merge_fields: { PLAN: plan, SOURCE: source } })
    }).catch(() => {});
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  if (secret && sig) {
    try { event = stripe.webhooks.constructEvent(req.body, sig, secret); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  } else {
    try { event = JSON.parse(req.body.toString()); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    const plan = obj.metadata?.plan || 'unbekannt';
    const email = obj.customer_email || obj.customer_details?.email || '?';
    const amt = obj.amount_total ? `€${(obj.amount_total / 100).toFixed(2)}` : '';
    sendTelegram(`🎉 <b>NEUE ZAHLUNG — Steuercockpit!</b>\n\n💳 Plan: <b>${plan}</b>\n📧 ${email}\n💰 ${amt}\n⏰ ${new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}`);
    if (email && email !== '?') subscribeToMarketing(email, plan, 'steuercockpit');
  } else if (event.type === 'invoice.payment_failed') {
    const amt = obj.amount_due ? `€${(obj.amount_due / 100).toFixed(2)}` : '';
    sendTelegram(`⚠️ <b>Steuercockpit: Zahlung fehlgeschlagen</b>\n${amt} · ${obj.customer_email || obj.customer}`);
  } else if (event.type === 'customer.subscription.deleted') {
    sendTelegram(`❌ <b>Steuercockpit: Abo gekündigt</b>\n🆔 ${obj.id}`);
  }

  res.json({ received: true, type: event.type });
});

// ── SEO Bridge (before SPA catch-all) ────────────────────────────────────────
seoBridge.addExpressRoutes(app, ['steuer software deutsch', 'steuererklaerung tool', 'abo cockpit deutsch']);

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Cron: Daily 08:00 Vienna ──────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
    sendTelegram(`📊 <b>Steuercockpit Daily Report</b>\n👥 Aktive Subs: <b>${subs.data.length}</b>\n⏰ ${new Date().toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}`);
  } catch (e) { console.error('Cron error:', e.message); }
}, { timezone: 'Europe/Vienna' });

seoBridge.startBackgroundSync(['steuer software deutsch', 'steuererklaerung tool', 'abo cockpit deutsch']);

// SEO Traffic Engine ingest — receives broadcasts from seo-traffic-engine
app.post('/api/ingest', async (req, res) => {
  try {
    const { title = '', url = '', keyword = '', product_name = '', product_url = '' } = req.body || {};
    const isTaxRelated = /steuer|abo|abonnement|finanz|tax|invoice/i.test(keyword + ' ' + title);
    const prefix = isTaxRelated ? '🎯 <b>Relevanter SEO Artikel!</b>' : '📰 <b>SEO Artikel → Steuercockpit</b>';
    sendTelegram(`${prefix}\n🔑 ${keyword}\n📄 ${title}\n🔗 ${url}\n🛒 ${product_name}: ${product_url}`);
    res.json({ status: 'ok', service: 'steuercockpit', processed: title, tax_relevant: isTaxRelated });
  } catch (e) {
    console.error('Ingest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3032;
app.listen(PORT, () => {
  console.log(`steuercockpit on :${PORT}`);
  console.log(`Claude: ${anthropic ? 'aktiv' : 'nicht konfiguriert'}`);
  console.log(`Telegram: ${!!(process.env.TELEGRAM_BOT_TOKEN) ? 'aktiv' : 'nicht konfiguriert'}`);
});
