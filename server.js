require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (process.env.NODE_ENV === 'production' && !APP_PASSWORD) {
  console.error('APP_PASSWORD is required in production so strangers cannot send email through your account.');
  process.exit(1);
}
if (APP_PASSWORD) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  app.use((req, res, next) => {
    const [scheme, enc] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && enc) {
      const pass = Buffer.from(enc, 'base64').toString().split(':').slice(1).join(':');
      if (crypto.timingSafeEqual(digest(pass), digest(APP_PASSWORD))) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Outreacher"');
    res.status(401).send('Password required');
  });
}
app.use(express.json({ limit: '10mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME = '',
  FROM_EMAIL,
  PORT = 3000,
} = process.env;

const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const jobs = new Map();

function render(template, row) {
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const found = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    return found ? String(row[found] ?? '') : '';
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtml(text) {
  return '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">' +
    escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/api/config', (req, res) => {
  res.json({ configured, from: FROM_EMAIL || SMTP_USER || '' });
});

app.post('/api/preview', (req, res) => {
  const { subject = '', body = '', row = {} } = req.body || {};
  res.json({ subject: render(subject, row), body: render(body, row) });
});

app.post('/api/send', (req, res) => {
  if (!configured) {
    return res.status(400).json({ error: 'Email is not configured. Fill in your .env file and restart the server.' });
  }
  const { recipients, delaySeconds = 3, emailColumn = 'email' } = req.body || {};
  let { templates, subject, body } = req.body || {};
  if (!Array.isArray(templates) || !templates.length) templates = [{ subject, body }];
  templates = templates.filter((t) => t && t.subject && t.body);
  if (!Array.isArray(recipients) || !recipients.length) {
    return res.status(400).json({ error: 'No recipients provided.' });
  }
  if (!templates.length) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    total: recipients.length,
    done: 0,
    sent: 0,
    failed: 0,
    status: 'running',
    cancelled: false,
    log: [],
  };
  jobs.set(id, job);
  res.json({ jobId: id });

  (async () => {
    const delay = Math.max(0, Number(delaySeconds)) * 1000;
    const seen = new Set();
    let n = 0;
    for (const row of recipients) {
      if (job.cancelled) break;
      const key = Object.keys(row).find((k) => k.toLowerCase() === String(emailColumn).toLowerCase());
      const to = key ? String(row[key]).trim() : '';
      const entry = { email: to, status: '', detail: '' };

      if (!EMAIL_RE.test(to)) {
        entry.status = 'skipped';
        entry.detail = 'Invalid email address';
        job.failed++;
      } else if (seen.has(to.toLowerCase())) {
        entry.status = 'skipped';
        entry.detail = 'Duplicate in file';
        job.failed++;
      } else {
        seen.add(to.toLowerCase());
        try {
          const tpl = templates[n++ % templates.length];
          const text = render(tpl.body, row);
          await transporter.sendMail({
            from: FROM_NAME ? `"${FROM_NAME}" <${FROM_EMAIL || SMTP_USER}>` : (FROM_EMAIL || SMTP_USER),
            to,
            subject: render(tpl.subject, row),
            text,
            html: toHtml(text),
          });
          entry.status = 'sent';
          job.sent++;
        } catch (err) {
          entry.status = 'failed';
          entry.detail = err.message;
          job.failed++;
        }
        if (delay && job.done < job.total - 1) await sleep(delay);
      }
      job.log.push(entry);
      job.done++;
    }
    job.status = job.cancelled ? 'cancelled' : 'finished';
  })();
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/api/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancelled = true;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Outreacher running at http://localhost:${PORT}`);
  if (!configured) console.log('Warning: SMTP not configured. Copy .env.example to .env and fill it in.');
});
