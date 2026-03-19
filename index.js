const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const { Resend } = require('resend');
const { z } = require('zod');
const crypto = require('crypto');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const port = process.env.PORT || 8080;

// ====================== CRITICAL FIX: TRUST PROXY ======================
app.set('trust proxy', 1);

// ====================== REQUEST ID ======================
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ====================== SECURITY MIDDLEWARE ======================
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ====================== RATE LIMITING ======================
// General API rate limit: 100 per 15 min
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use(generalLimiter);

// Resend-specific rate limit: Max 4 per second (under their 5/sec limit)
const resendLimiter = rateLimit({
  windowMs: 1000,      // 1 second window
  max: 4,              // 4 requests per second (safe under 5/sec)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'resend-global', // Global limit across all IPs
  message: { success: false, error: 'Email rate limit exceeded. Please wait a moment.' }
});

// ====================== VALIDATION SCHEMA ======================
const emailSchema = z.object({
  to: z.string().email('Valid email required'),
  subject: z.preprocess(
    (val) => (val === "" || val === null || val === undefined ? 'New message from Chime' : val),
    z.string().min(1).max(200)
  ),
  message: z.string().min(1),
  html: z.string().optional()
});

// ====================== HEALTH & ROOT ======================
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  res.json({
    message: '🚀 Chime Email API',
    version: '2.1',
    domain: 'brigit.work'
  });
});

// ====================== EMAIL ENDPOINT WITH RESEND RATE LIMIT ======================
app.post('/send', resendLimiter, async (req, res) => {
  const parseResult = emailSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ 
      success: false, 
      error: parseResult.error.errors[0].message 
    });
  }

  const { to, subject, message, html } = parseResult.data;

  if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
    return res.status(500).json({ 
      success: false, 
      error: 'Missing RESEND_API_KEY or FROM_EMAIL' 
    });
  }

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      text: message,
      html: html || undefined,
      replyTo: process.env.REPLY_TO || undefined
    });

    if (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Resend API error',
        requestId: req.id,
        error: error.message,
        timestamp: new Date().toISOString()
      }));
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(JSON.stringify({
      level: 'info',
      message: 'Email sent',
      requestId: req.id,
      emailId: data.id,
      to: to,
      timestamp: new Date().toISOString()
    }));

    res.json({
      success: true,
      emailId: data.id,
      message: 'Email sent successfully ✅'
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Unexpected error',
      requestId: req.id,
      error: err.message,
      timestamp: new Date().toISOString()
    }));
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================== SERVER START ======================
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Chime Email API running on port ${port}`);
  console.log(`📧 Sending from: ${process.env.FROM_EMAIL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – shutting down gracefully');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});
