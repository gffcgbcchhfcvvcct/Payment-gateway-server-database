/**
 * NexaPay Backend Server
 * ─────────────────────
 * Serves the frontend static files and all API routes.
 * Connects to Supabase for DB + Auth.
 *
 * REMOVE the hardcoded keys below before making this repository public.
 * Replace with environment variables on your hosting platform (Railway etc.).
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 5000;

/* ── Hardcoded config — edit before making repo public ── */
const SUPABASE_URL = 'https://yfmflzasmxpjtrmolgwc.supabase.co';
const SUPABASE_SERVICE_KEY = 'sb_secret_NRfxt7OOdnY74T0yUkcWJA_EhNqQZj8';
const ADMIN_SECRET_KEY = '3462Abel';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ── Rate limiting ── */
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

/* ── Multer (file uploads, stored in Supabase Storage) ── */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ── Middleware ── */
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(limiter);

/* ── Serve frontend static files ── */
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ── Auth middleware for protected routes ── */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

/* ── Admin middleware ── */
function adminMiddleware(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* ════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════ */

/* Save business profile after signup */
app.post('/api/auth/profile', authMiddleware, async (req, res) => {
  const { full_name, business_name, business_sector, country, phone,
          is_operated, business_type, currency } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  const currencyMap = { Zambia: 'ZMW', Zimbabwe: 'USD', Namibia: 'NAD', Botswana: 'BWP' };
  const userCurrency = currency || currencyMap[country] || 'USD';

  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    full_name,
    business_name,
    business_sector,
    country,
    email,
    phone,
    is_operated,
    business_type,
    currency: userCurrency,
    account_type: 'business',
    verification_status: 'not_verified',
    created_at: new Date().toISOString()
  }, { onConflict: 'id' });

  if (error) return res.status(400).json({ error: error.message });

  /* Create wallet for user */
  await supabase.from('wallets').upsert({
    user_id: userId,
    currency: userCurrency,
    country,
    balance: 0,
    locked_balance: 0,
    available_balance: 0
  }, { onConflict: 'user_id' });

  /* Generate API keys */
  const testPublishable = 'npay_test_pub_' + uuidv4().replace(/-/g, '');
  const testSecret = 'npay_test_sec_' + uuidv4().replace(/-/g, '');
  await supabase.from('api_keys').upsert({
    user_id: userId,
    test_publishable_key: testPublishable,
    test_secret_key: testSecret,
    is_live: false
  }, { onConflict: 'user_id' });

  /* Create default notification */
  await supabase.from('notifications').insert({
    user_id: userId,
    title: 'Welcome to NexaPay!',
    message: 'Your business account has been created. Complete account verification to access all features.',
    type: 'info',
    read: false
  });

  res.json({ success: true, currency: userCurrency });
});

/* Get profile */
app.get('/api/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

/* Update profile */
app.put('/api/profile', authMiddleware, async (req, res) => {
  const allowed = ['full_name', 'phone', 'business_name', 'business_sector'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('profiles').update(updates).eq('id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   DASHBOARD STATS (HOME)
════════════════════════════════════════════ */
app.get('/api/stats/home', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayISO = today.toISOString();

  const [payinRes, payoutRes, pendingRes, settlementRes] = await Promise.all([
    supabase.from('transactions').select('amount').eq('user_id', uid).eq('type', 'payin').eq('status', 'completed').gte('created_at', todayISO),
    supabase.from('transactions').select('amount').eq('user_id', uid).eq('type', 'payout').eq('status', 'completed').gte('created_at', todayISO),
    supabase.from('transactions').select('id').eq('user_id', uid).eq('status', 'pending'),
    supabase.from('settlements').select('amount').eq('user_id', uid).eq('status', 'pending')
  ]);

  const payinTotal = (payinRes.data || []).reduce((s, r) => s + Number(r.amount), 0);
  const payoutTotal = (payoutRes.data || []).reduce((s, r) => s + Number(r.amount), 0);
  const pendingCount = (pendingRes.data || []).length;
  const settlementTotal = (settlementRes.data || []).reduce((s, r) => s + Number(r.amount), 0);

  res.json({ payin_today: payinTotal, payout_today: payoutTotal, pending_transactions: pendingCount, pending_settlement: settlementTotal });
});

/* Latest transactions (payin, today) */
app.get('/api/stats/latest-transactions', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const today = new Date(); today.setHours(0,0,0,0);
  const { data, error } = await supabase.from('transactions').select('*').eq('user_id', uid).eq('type', 'payin').gte('created_at', today.toISOString()).order('created_at', { ascending: false }).limit(10);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* ════════════════════════════════════════════
   WALLETS
════════════════════════════════════════════ */
app.get('/api/wallets', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('wallets').select('*').eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* ════════════════════════════════════════════
   TRANSACTIONS
════════════════════════════════════════════ */
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { type, status, page = 1, limit: lim = 20 } = req.query;
  let query = supabase.from('transactions').select('*', { count: 'exact' }).eq('user_id', req.user.id).order('created_at', { ascending: false }).range((page-1)*lim, page*lim - 1);
  if (type) query = query.eq('type', type);
  if (status) query = query.eq('status', status);
  const { data, count, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data: data || [], total: count || 0, page: Number(page), limit: Number(lim) });
});

/* ════════════════════════════════════════════
   SETTLEMENTS
════════════════════════════════════════════ */
app.get('/api/settlements', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('settlements').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/settlements', authMiddleware, async (req, res) => {
  const { amount, bank_name, account_number, account_name, notes } = req.body;
  if (!amount || !bank_name || !account_number || !account_name) return res.status(400).json({ error: 'Missing required fields' });

  const { data: wallet } = await supabase.from('wallets').select('available_balance').eq('user_id', req.user.id).single();
  if (!wallet || Number(wallet.available_balance) < Number(amount)) return res.status(400).json({ error: 'Insufficient available balance' });

  const { error } = await supabase.from('settlements').insert({
    user_id: req.user.id,
    amount: Number(amount),
    bank_name,
    account_number,
    account_name,
    notes,
    status: 'pending',
    reference: 'STL-' + uuidv4().split('-')[0].toUpperCase()
  });
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('wallets').update({ locked_balance: supabase.rpc('increment_locked', { uid: req.user.id, amt: amount }) }).eq('user_id', req.user.id);
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   PAYMENT LINKS
════════════════════════════════════════════ */
app.get('/api/payment-links', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('payment_links').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/payment-links', authMiddleware, async (req, res) => {
  const { name, amount, currency, description, expires_at } = req.body;
  if (!name || !amount) return res.status(400).json({ error: 'Name and amount are required' });

  const linkId = uuidv4().split('-')[0].toLowerCase();
  const link = `https://pay.nexapay.com/l/${linkId}`;

  const { data, error } = await supabase.from('payment_links').insert({
    user_id: req.user.id,
    name,
    amount: Number(amount),
    currency,
    description,
    link_id: linkId,
    url: link,
    status: 'active',
    expires_at: expires_at || null,
    clicks: 0,
    payments: 0
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, link: data });
});

app.delete('/api/payment-links/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('payment_links').update({ status: 'inactive' }).eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   DISBURSEMENT REQUESTS
════════════════════════════════════════════ */
app.get('/api/disbursements', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('disbursements').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/disbursements', authMiddleware, async (req, res) => {
  const { beneficiary_id, amount, notes } = req.body;
  if (!beneficiary_id || !amount) return res.status(400).json({ error: 'Beneficiary and amount are required' });

  const { data: benef } = await supabase.from('beneficiaries').select('*').eq('id', beneficiary_id).eq('user_id', req.user.id).single();
  if (!benef) return res.status(404).json({ error: 'Beneficiary not found' });

  const { error } = await supabase.from('disbursements').insert({
    user_id: req.user.id,
    beneficiary_id,
    beneficiary_name: benef.name,
    beneficiary_account: benef.account_number,
    amount: Number(amount),
    notes,
    status: 'pending',
    reference: 'DIS-' + uuidv4().split('-')[0].toUpperCase()
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* Beneficiaries */
app.get('/api/beneficiaries', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('beneficiaries').select('*').eq('user_id', req.user.id).order('name');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/beneficiaries', authMiddleware, async (req, res) => {
  const { name, account_number, bank_name, phone, type } = req.body;
  if (!name || !account_number) return res.status(400).json({ error: 'Name and account number required' });
  const { error } = await supabase.from('beneficiaries').insert({ user_id: req.user.id, name, account_number, bank_name, phone, type: type || 'bank' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/beneficiaries/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('beneficiaries').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   WEBHOOK HISTORY
════════════════════════════════════════════ */
app.get('/api/webhooks', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('webhook_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/webhooks/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('webhook_history').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

/* Webhook configuration */
app.get('/api/webhook-config', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('webhook_configs').select('*').eq('user_id', req.user.id).single();
  res.json(data || { webhook_url: '', events: [] });
});

app.post('/api/webhook-config', authMiddleware, async (req, res) => {
  const { webhook_url, events } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Webhook URL required' });

  const { error } = await supabase.from('webhook_configs').upsert({
    user_id: req.user.id,
    webhook_url,
    events: events || ['payin.success', 'payin.failed', 'payout.success', 'payout.failed'],
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('webhook_history').insert({
    user_id: req.user.id,
    url: webhook_url,
    event: 'webhook.configured',
    status: 'SUCCESS',
    attempts: 1,
    request_payload: JSON.stringify({ event: 'webhook.configured', timestamp: Date.now(), url: webhook_url }),
    response_status: 200
  });

  res.json({ success: true });
});

/* ════════════════════════════════════════════
   API KEYS
════════════════════════════════════════════ */
app.get('/api/api-keys', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('api_keys').select('*').eq('user_id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.post('/api/api-keys/regenerate', authMiddleware, async (req, res) => {
  const { key_type } = req.body;
  if (!['test_secret_key', 'live_publishable_key', 'live_secret_key'].includes(key_type)) return res.status(400).json({ error: 'Invalid key type' });

  const newKey = key_type.includes('test') ? 'npay_test_' + (key_type.includes('pub') ? 'pub' : 'sec') + '_' + uuidv4().replace(/-/g,'') :
                 'npay_live_' + (key_type.includes('pub') ? 'pub' : 'sec') + '_' + uuidv4().replace(/-/g,'');

  const { error } = await supabase.from('api_keys').update({ [key_type]: newKey, updated_at: new Date().toISOString() }).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, key: newKey });
});

/* ════════════════════════════════════════════
   IP WHITELIST
════════════════════════════════════════════ */
app.get('/api/ip-whitelist', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('ip_whitelist').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/ip-whitelist', authMiddleware, async (req, res) => {
  const { ip_address, label } = req.body;
  if (!ip_address) return res.status(400).json({ error: 'IP address required' });
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (!ipRegex.test(ip_address)) return res.status(400).json({ error: 'Invalid IP address format' });
  const { error } = await supabase.from('ip_whitelist').insert({ user_id: req.user.id, ip_address, label: label || ip_address });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/ip-whitelist/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('ip_whitelist').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   NOTIFICATIONS
════════════════════════════════════════════ */
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  await supabase.from('notifications').update({ read: true }).eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

app.post('/api/notifications/mark-all-read', authMiddleware, async (req, res) => {
  await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.id).eq('read', false);
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   SETTINGS
════════════════════════════════════════════ */
app.get('/api/settings', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', req.user.id).single();
  res.json(data || {
    email_notifications: true,
    sms_notifications: false,
    two_factor_auth: false,
    cookie_analytics: true,
    cookie_marketing: false,
    session_timeout: 60,
    language: 'en',
    timezone: 'Africa/Lusaka'
  });
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('user_settings').upsert({
    user_id: req.user.id,
    ...req.body,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   ACCOUNT VERIFICATION (KYC)
════════════════════════════════════════════ */

/* GET /api/verification/status — returns status + documents in dashboard-ready format */
app.get('/api/verification/status', authMiddleware, async (req, res) => {
  const uid = req.user.id;

  // Get profile for business_type
  const { data: profile } = await supabase.from('profiles').select('verification_status, business_type, business_name').eq('id', uid).single();

  // Get latest submission
  const { data: submission } = await supabase.from('verification_submissions').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1).single();

  // Get uploaded documents
  const { data: docs } = await supabase.from('verification_documents').select('*').eq('user_id', uid).order('created_at', { ascending: false });

  // Determine overall status
  let status = 'not_started';
  if (profile && profile.verification_status === 'verified') status = 'verified';
  else if (profile && profile.verification_status === 'rejected') status = 'rejected';
  else if (submission && submission.status === 'pending') status = 'submitted';
  else if (docs && docs.length > 0) status = 'submitted';

  res.json({
    status,
    business_type: (profile && profile.business_type) || 'Business',
    expires_at: (submission && submission.expires_at) || null,
    documents: (docs || []).map(d => ({
      id: d.id,
      document_type: d.document_type,
      filename: d.filename || d.file_path?.split('/').pop() || '—',
      file_url: d.file_url,
      file_size: d.file_size || '—',
      status: d.status === 'approved' ? 'verified' : (d.status === 'rejected' ? 'rejected' : 'pending'),
      created_at: d.created_at
    }))
  });
});

/* POST /api/verification/upload — upload a KYC document */
app.post('/api/verification/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { document_type } = req.body;
  if (!document_type) return res.status(400).json({ error: 'Document type required' });

  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `kyc/${req.user.id}/${uuidv4()}.${ext}`;
  const fileSizeKB = (req.file.size / 1024).toFixed(2) + ' KB';

  const { error: uploadError } = await supabase.storage.from('kyc-documents').upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) {
    // If bucket doesn't exist or storage fails, still record the document
    console.error('Storage upload failed:', uploadError.message);
  }

  const { data: { publicUrl } } = supabase.storage.from('kyc-documents').getPublicUrl(filePath);

  const { error } = await supabase.from('verification_documents').insert({
    user_id: req.user.id,
    document_type,
    filename: safeName,
    file_path: filePath,
    file_url: publicUrl || '',
    file_size: fileSizeKB,
    status: 'pending',
    upload_status: 'uploaded',
    created_at: new Date().toISOString()
  });

  if (error) return res.status(400).json({ error: error.message });

  // Update profile verification_status to 'submitted' if not already verified
  await supabase.from('profiles').update({ verification_status: 'submitted' }).eq('id', req.user.id).not('verification_status', 'eq', 'verified');

  // Upsert submission record
  await supabase.from('verification_submissions').upsert({
    user_id: req.user.id,
    status: 'pending',
    submitted_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  res.json({ success: true, url: publicUrl, document_type, filename: safeName, file_size: fileSizeKB });
});

/* DELETE /api/verification/document/:id — delete a pending document */
app.delete('/api/verification/document/:id', authMiddleware, async (req, res) => {
  const { data: doc } = await supabase.from('verification_documents').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status === 'approved') return res.status(400).json({ error: 'Cannot delete an approved document' });

  // Remove from storage if possible
  if (doc.file_path) await supabase.storage.from('kyc-documents').remove([doc.file_path]);

  const { error } = await supabase.from('verification_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* POST /api/verification/submit — mark submission as pending review */
app.post('/api/verification/submit', authMiddleware, async (req, res) => {
  const { data: docs } = await supabase.from('verification_documents').select('*').eq('user_id', req.user.id);
  if (!docs || docs.length === 0) return res.status(400).json({ error: 'Upload at least one document before submitting' });

  await supabase.from('verification_submissions').upsert({
    user_id: req.user.id,
    status: 'pending',
    submitted_at: new Date().toISOString(),
    document_count: docs.length
  }, { onConflict: 'user_id' });

  await supabase.from('profiles').update({ verification_status: 'submitted' }).eq('id', req.user.id);
  await supabase.from('notifications').insert({
    user_id: req.user.id,
    title: 'Verification submitted',
    message: 'Your account verification documents have been submitted and are under review. This usually takes 1–2 business days.',
    type: 'info',
    read: false
  });

  res.json({ success: true });
});

/* ════════════════════════════════════════════
   ADMIN ROUTES
════════════════════════════════════════════ */
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const [users, pending, transactions, settlements] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact' }),
    supabase.from('verification_submissions').select('id', { count: 'exact' }).eq('status', 'pending'),
    supabase.from('transactions').select('amount').gte('created_at', new Date(Date.now() - 86400000).toISOString()),
    supabase.from('settlements').select('amount').eq('status', 'pending')
  ]);
  res.json({
    total_users: users.count || 0,
    pending_verifications: pending.count || 0,
    today_volume: (transactions.data || []).reduce((s, r) => s + Number(r.amount), 0),
    pending_settlements: (settlements.data || []).reduce((s, r) => s + Number(r.amount), 0)
  });
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const { page = 1, limit: lim = 20, search, status } = req.query;
  let query = supabase.from('profiles').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range((page-1)*lim, page*lim - 1);
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,business_name.ilike.%${search}%`);
  if (status) query = query.eq('verification_status', status);
  const { data, count, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data: data || [], total: count || 0 });
});

app.patch('/api/admin/users/:id/status', adminMiddleware, async (req, res) => {
  const { is_disabled } = req.body;
  const { error } = await supabase.from('profiles').update({ is_disabled, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });

  if (is_disabled) {
    await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: 'none' });
  }
  res.json({ success: true });
});

app.get('/api/admin/verifications', adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('verification_submissions').select(`*, profiles:user_id(full_name, email, business_name, country)`).eq('status', 'pending').order('submitted_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/admin/verifications/:userId', adminMiddleware, async (req, res) => {
  const { status, rejection_reason } = req.body;
  if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  await supabase.from('verification_submissions').update({ status, reviewed_at: new Date().toISOString(), rejection_reason: rejection_reason || null }).eq('user_id', req.params.userId);
  await supabase.from('profiles').update({ verification_status: status === 'verified' ? 'verified' : 'rejected' }).eq('id', req.params.userId);

  const msg = status === 'verified' ? 'Congratulations! Your account has been verified. You now have full access to all NexaPay features.' :
    `Your verification was not approved. Reason: ${rejection_reason || 'Documents did not meet requirements'}. Please resubmit.`;

  await supabase.from('notifications').insert({ user_id: req.params.userId, title: status === 'verified' ? '✅ Account Verified!' : '❌ Verification Rejected', message: msg, type: status === 'verified' ? 'success' : 'error', read: false });
  res.json({ success: true });
});

app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('*, profiles:user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/admin/settlements', adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('settlements').select('*, profiles:user_id(full_name, email, business_name)').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/admin/settlements/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const { data: stl } = await supabase.from('settlements').select('*').eq('id', req.params.id).single();
  if (!stl) return res.status(404).json({ error: 'Not found' });

  await supabase.from('settlements').update({ status, processed_at: new Date().toISOString() }).eq('id', req.params.id);
  if (status === 'approved') {
    await supabase.from('wallets').update({ balance: supabase.rpc('decrement_balance', { uid: stl.user_id, amt: stl.amount }), available_balance: supabase.rpc('decrement_available', { uid: stl.user_id, amt: stl.amount }) }).eq('user_id', stl.user_id);
    await supabase.from('notifications').insert({ user_id: stl.user_id, title: 'Settlement Approved', message: `Your settlement of ${stl.amount} has been approved and will be processed shortly.`, type: 'success', read: false });
  }
  res.json({ success: true });
});

/* ── Health check ── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ── Catch-all: serve index / auth ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'auth.html'));
});

app.listen(PORT, () => {
  console.log(`NexaPay server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}/auth.html`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`Admin: http://localhost:${PORT}/admin.html`);
});
