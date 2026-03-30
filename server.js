require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const nodemailer = require('nodemailer');
const AfricaTalking = require('africastalking');

// M-Pesa Daraja API Configuration - PRODUCTION
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || 'aJ1vnpKSNrAVGTvcBXL7UvD9z9cTbNJclovxj33WXroky9G7',
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || 'jZeKAn1OJCAue0N3ey1FqEVzY3lOvI957N9GIC0G8ibqA1CJqCIRVpZFbXp8liaG',
  shortCode: process.env.MPESA_SHORTCODE || 'your_production_shortcode_here',
  passkey: process.env.MPESA_PASSKEY || 'your_production_passkey_here',
  environment: process.env.MPESA_ENVIRONMENT || 'production',
  callbackUrl: process.env.MPESA_CALLBACK_URL || 'https://your-domain.com/api/mpesa/callback'
};

const MPESA_BASE_URL = MPESA_CONFIG.environment === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Africa's Talking SMS Configuration
const africastalking = AfricaTalking({
  username: process.env.AFRICAS_TALKING_USERNAME || 'sandbox',
  apiKey: process.env.AFRICAS_TALKING_API_KEY || 'sandbox',
});

// Email Configuration
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
};

const emailTransporter = nodemailer.createTransport(emailConfig);

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || crypto.randomBytes(32).toString('hex');
const allowedOrigins = new Set([
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
].filter(Boolean));

// Security middleware - relaxed for development
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(morgan('dev'));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8, // limit auth attempts to 8 per window
  message: { error: 'Too many login attempts, please try again after 15 minutes' }
});

// Middleware
app.use(bodyParser.json({ limit: '10kb' }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    try {
      const hostname = new URL(origin).hostname;
      if (allowedOrigins.has(origin) || hostname.endsWith('.vercel.app')) {
        return callback(null, true);
      }
    } catch (error) {
      return callback(new Error('Invalid origin'));
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use('/api', apiLimiter);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const mongoUri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  'mongodb://127.0.0.1:27017/loanReminder';
let mongoConnectionPromise;

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) {
    return '';
  }

  const digitsOnly = String(phoneNumber).replace(/\D/g, '');

  if (digitsOnly.startsWith('254') && digitsOnly.length === 12) {
    return `+${digitsOnly}`;
  }

  if (digitsOnly.startsWith('0') && digitsOnly.length === 10) {
    return `+254${digitsOnly.slice(1)}`;
  }

  if (digitsOnly.length === 9) {
    return `+254${digitsOnly}`;
  }

  return '';
}

async function ensureDatabaseConnection() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose.connect(mongoUri)
      .then(connection => {
        console.log('MongoDB Connected');
        return connection;
      })
      .catch(err => {
        mongoConnectionPromise = null;
        console.error('MongoDB Error:', err.message);
        throw err;
      });
  }

  return mongoConnectionPromise;
}

app.use(async (req, res, next) => {
  try {
    await ensureDatabaseConnection();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// SCHEMAS - with validation
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 30 },
  email: { type: String, lowercase: true, trim: true, match: [/^\S+@\S+\.\S+$/, 'Invalid email'] },
  password: { type: String, required: true, minlength: 6 },
  isAdmin: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false, index: true },
  blockedAt: Date,
  blockedReason: { type: String, trim: true, maxlength: 500 },
  blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phoneNumber: { type: String, trim: true },
  fullName: { type: String, trim: true, maxlength: 100 },
  dateOfBirth: Date,
  location: { type: String, trim: true, maxlength: 100 },
  occupation: { type: String, trim: true, maxlength: 100 },
  bio: { type: String, trim: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const loanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  loanName: { type: String, required: true, trim: true, maxlength: 100 },
  loanAmount: { type: Number, required: true, min: 100 },
  bankName: { type: String, required: true, trim: true, maxlength: 50 },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['active', 'paid', 'overdue'], default: 'active', index: true },
  remainingBalance: { type: Number, default: function() { return this.loanAmount; } },
  interestRate: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Loan = mongoose.model('Loan', loanSchema);

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  loanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, default: 'mpesa' },
  paymentDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  rejectionReason: String,
  rejectedAt: Date,
  approvedAt: Date,
  mpesaCheckoutRequestID: String,
  mpesaReceiptNumber: String,
  mpesaPhoneNumber: String
});
const Payment = mongoose.model('Payment', paymentSchema);

const querySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  category: { type: String, enum: ['loan_issue', 'payment_issue', 'bank_related', 'account_issue', 'general'], required: true },
  subject: { type: String, required: true, trim: true, maxlength: 200 },
  message: { type: String, required: true, maxlength: 2000 },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
  adminResponse: {
    message: String,
    respondedAt: Date,
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  createdAt: { type: Date, default: Date.now }
});
const Query = mongoose.model('Query', querySchema);

// Notification Schema for reminders
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  loanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', required: true },
  type: { type: String, enum: ['sms', 'email', 'in_app'], required: true },
  reminderType: { type: String, enum: ['loan_created', '7_days_before', '3_days_before', '1_day_before', 'due_date', 'overdue'], required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true },
  sentAt: Date,
  errorMessage: String,
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

// Direct Message Schema for inbox/messaging
const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 5000 },
  isRead: { type: Boolean, default: false, index: true },
  isDeleted: { type: Boolean, default: false },
  parentMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', index: true },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// AUTH MIDDLEWARE
function isBlockedRouteAllowed(req) {
  return req.path === '/queries' && (req.method === 'GET' || req.method === 'POST');
}

const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (user.isBlocked && !user.isAdmin && !isBlockedRouteAllowed(req)) {
      return res.status(403).json({
        error: 'Sorry you have been blocked from access. You can only use the support query page to contact the admin.',
        code: 'USER_BLOCKED',
        blocked: true,
        restrictedToQueries: true
      });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
};

// ==================== NOTIFICATION SERVICES ====================

// Send SMS via Africa's Talking
async function sendSMS(phoneNumber, message) {
  try {
    if (!phoneNumber) {
      console.log('⚠️ No phone number provided for SMS');
      return { success: false, error: 'No phone number' };
    }

    const smsService = africastalking.SMS;
    const result = await smsService.send({
      to: [phoneNumber],
      message: message,
      from: process.env.AFRICAS_TALKING_SHORTCODE || undefined,
    });

    console.log('✅ SMS sent to:', phoneNumber);
    return { success: true, result };
  } catch (error) {
    console.error('❌ SMS send error:', error.message);
    return { success: false, error: error.message };
  }
}

// Send Email via Nodemailer
async function sendEmail(to, subject, htmlContent) {
  try {
    if (!to || !process.env.EMAIL_USER) {
      console.log('⚠️ Email not configured or no recipient');
      return { success: false, error: 'Email not configured' };
    }

    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Loan Reminder <noreply@loanreminder.com>',
      to: to,
      subject: subject,
      html: htmlContent,
    });

    console.log('✅ Email sent to:', to, 'Message ID:', info.messageId);
    return { success: true, result: info };
  } catch (error) {
    console.error('❌ Email send error:', error.message);
    return { success: false, error: error.message };
  }
}

// Send In-App Notification
async function sendInAppNotification(userId, loanId, reminderType, message) {
  try {
    const notification = new Notification({
      userId,
      loanId,
      type: 'in_app',
      reminderType,
      message,
      status: 'sent',
      sentAt: new Date(),
    });
    await notification.save();
    console.log('✅ In-app notification created for user:', userId);
    return { success: true, notification };
  } catch (error) {
    console.error('❌ In-app notification error:', error.message);
    return { success: false, error: error.message };
  }
}

// Send Payment Reminder (SMS + Email + In-App)
async function sendPaymentReminder(user, loan, reminderType) {
  try {
    const daysUntilDue = Math.ceil((loan.dueDate - new Date()) / (1000 * 60 * 60 * 24));
    const reminderMessages = {
      '7_days_before': `Hi ${user.username}, this is a reminder that your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} is due in 7 days (${loan.dueDate.toLocaleDateString()}). - Loan Reminder`,
      '3_days_before': `Hi ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} is due in 3 days (${loan.dueDate.toLocaleDateString()}). Please prepare for payment. - Loan Reminder`,
      '1_day_before': `URGENT: ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} is due TOMORROW (${loan.dueDate.toLocaleDateString()}). Don't forget! - Loan Reminder`,
      'due_date': `TODAY IS THE DAY! ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} is due TODAY. Please make the payment. - Loan Reminder`,
      'overdue': `OVERDUE NOTICE: ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} (due ${loan.dueDate.toLocaleDateString()}) is now overdue. Please pay immediately to avoid penalties. - Loan Reminder`,
    };

    const message = reminderMessages[reminderType] || `Payment Reminder: ${loan.loanName} - KSh ${loan.loanAmount.toLocaleString()} due ${loan.dueDate.toLocaleDateString()}`;

    // Send all notification types in parallel
    const results = await Promise.allSettled([
      user.phoneNumber ? sendSMS(user.phoneNumber, message) : Promise.resolve({ success: false, error: 'No phone' }),
      user.email ? sendEmail(user.email, `Payment Reminder: ${loan.loanName}`, `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">💰 Payment Reminder</h2>
          <p>Dear ${user.username},</p>
          <p>This is a friendly reminder about your upcoming loan payment:</p>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Loan Name:</strong> ${loan.loanName}</p>
            <p><strong>Bank:</strong> ${loan.bankName}</p>
            <p><strong>Amount:</strong> KSh ${loan.loanAmount.toLocaleString()}</p>
            <p><strong>Due Date:</strong> ${loan.dueDate.toLocaleDateString()}</p>
            <p><strong>Days Remaining:</strong> ${daysUntilDue} days</p>
          </div>
          <p style="color: #666;">Thank you for using Loan Reminder!</p>
          <p style="font-size: 12px; color: #999;">© 2026 Loan Reminder. All rights reserved.</p>
        </div>
      `) : Promise.resolve({ success: false, error: 'No email' }),
      sendInAppNotification(user._id, loan._id, reminderType, message),
    ]);

    console.log('📬 Reminder sent for loan:', loan._id, 'Type:', reminderType);
    return { success: true, results };
  } catch (error) {
    console.error('❌ Send reminder error:', error.message);
    return { success: false, error: error.message };
  }
}

// ROUTES

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

// Public user count
app.get('/stats/public', async (req, res) => {
  try {
    const count = await User.countDocuments({ isAdmin: false });
    res.json({ totalUsers: count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create admin (initial setup)
app.post('/admin/create', async (req, res) => {
  try {
    if (req.body.secretKey !== ADMIN_SECRET_KEY) {
      return res.status(403).json({ error: 'Invalid secret key' });
    }

    const { username, password, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' });
    }

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) {
      existing.isAdmin = true;
      await existing.save();
      const token = jwt.sign({ id: existing._id, username: existing.username, isAdmin: true }, JWT_SECRET);
      return res.json({ token, user: { username: existing.username, isAdmin: true } });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = new User({
      username: username.toLowerCase(),
      email: email?.toLowerCase(),
      password: hashed,
      isAdmin: true
    });
    await user.save();

    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: true }, JWT_SECRET);
    res.json({ token, user: { username: user.username, isAdmin: true } });
  } catch (err) {
    console.error('Admin creation error:', err);
    res.status(500).json({ error: 'Admin creation failed' });
  }
});

// Signup with rate limiting
app.post('/signup', authLimiter, async (req, res) => {
  try {
    const { username, email, password, phoneNumber } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedPhoneNumber = phoneNumber ? normalizePhoneNumber(phoneNumber) : '';
    if (phoneNumber && !normalizedPhoneNumber) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    const existingUser = await User.findOne({
      $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }]
    });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: hashedPassword,
      phoneNumber: normalizedPhoneNumber || undefined
    });
    await user.save();

    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: false }, JWT_SECRET);
    res.json({
      message: 'Account created successfully',
      token,
      user: {
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber,
        isAdmin: false
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Login with rate limiting
app.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await User.findOne({ username: username.toLowerCase() });

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET);
    res.json({
      token,
      blocked: !!user.isBlocked && !user.isAdmin,
      restrictedToQueries: !!user.isBlocked && !user.isAdmin,
      message: user.isBlocked && !user.isAdmin
        ? 'Sorry you have been blocked from access. You can only send a query to the admin.'
        : 'Login successful',
      user: {
        _id: user._id,
        username: user.username,
        email: user.email || '',
        isAdmin: user.isAdmin,
        isBlocked: !!user.isBlocked,
        blockedReason: user.blockedReason || ''
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/profile', verifyToken, async (req, res) => {
  try {
    res.json({
      user: {
        username: req.user.username,
        email: req.user.email || '',
        phoneNumber: req.user.phoneNumber || '',
        fullName: req.user.fullName || '',
        dateOfBirth: req.user.dateOfBirth || null,
        location: req.user.location || '',
        occupation: req.user.occupation || '',
        bio: req.user.bio || '',
        createdAt: req.user.createdAt,
        isAdmin: req.user.isAdmin,
        isBlocked: !!req.user.isBlocked,
        blockedReason: req.user.blockedReason || ''
      }
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/profile', verifyToken, async (req, res) => {
  try {
    const { email, phoneNumber, fullName, dateOfBirth, location, occupation, bio } = req.body;

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const normalizedPhoneNumber = phoneNumber ? normalizePhoneNumber(phoneNumber) : '';
    if (phoneNumber && !normalizedPhoneNumber) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    const existingEmailOwner = await User.findOne({
      email: email.toLowerCase(),
      _id: { $ne: req.user._id }
    });

    if (existingEmailOwner) {
      return res.status(400).json({ error: 'Email is already in use' });
    }

    req.user.email = email.toLowerCase();
    req.user.phoneNumber = normalizedPhoneNumber || undefined;
    req.user.fullName = fullName?.trim() || undefined;
    req.user.location = location?.trim() || undefined;
    req.user.occupation = occupation?.trim() || undefined;
    req.user.bio = bio?.trim() || undefined;
    req.user.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : undefined;

    if (dateOfBirth && Number.isNaN(req.user.dateOfBirth.getTime())) {
      return res.status(400).json({ error: 'Invalid date of birth' });
    }

    await req.user.save();

    res.json({
      message: 'Profile updated successfully',
      user: {
        username: req.user.username,
        email: req.user.email || '',
        phoneNumber: req.user.phoneNumber || '',
        fullName: req.user.fullName || '',
        dateOfBirth: req.user.dateOfBirth || null,
        location: req.user.location || '',
        occupation: req.user.occupation || '',
        bio: req.user.bio || '',
        createdAt: req.user.createdAt,
        isAdmin: req.user.isAdmin
      }
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Admin stats
app.get('/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [totalUsers, totalAdmins, totalLoans, totalPayments] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isAdmin: true }),
      Loan.countDocuments(),
      Payment.countDocuments()
    ]);

    res.json({
      stats: {
        users: {
          total: totalUsers,
          admins: totalAdmins,
          regular: totalUsers - totalAdmins
        },
        loans: totalLoans,
        payments: totalPayments
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Stats failed' });
  }
});

// Admin users
app.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Users fetch failed' });
  }
});

// Promote user to admin
app.put('/admin/promote-user/:userId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.isAdmin) {
      return res.status(400).json({ error: 'User is already an admin' });
    }
    
    user.isAdmin = true;
    await user.save();
    
    res.json({ message: 'User promoted to admin', user: { username: user.username, isAdmin: true } });
  } catch (err) {
    console.error('Promote user error:', err);
    res.status(500).json({ error: 'Failed to promote user' });
  }
});

app.put('/admin/users/:userId/block', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isAdmin) {
      return res.status(400).json({ error: 'Admin accounts cannot be blocked here' });
    }

    if (user.isBlocked) {
      return res.status(400).json({ error: 'User is already blocked' });
    }

    const reason = String(req.body.reason || '').trim();
    user.isBlocked = true;
    user.blockedAt = new Date();
    user.blockedReason = reason || 'Access restricted by admin';
    user.blockedBy = req.user._id;
    await user.save();

    res.json({
      message: 'User blocked successfully',
      user: {
        _id: user._id,
        username: user.username,
        isBlocked: true,
        blockedReason: user.blockedReason
      }
    });
  } catch (err) {
    console.error('Block user error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

app.put('/admin/users/:userId/unblock', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isAdmin) {
      return res.status(400).json({ error: 'Admin accounts cannot be changed here' });
    }

    user.isBlocked = false;
    user.blockedAt = undefined;
    user.blockedReason = '';
    user.blockedBy = undefined;
    await user.save();

    res.json({
      message: 'User unblocked successfully',
      user: {
        _id: user._id,
        username: user.username,
        isBlocked: false
      }
    });
  } catch (err) {
    console.error('Unblock user error:', err);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

app.delete('/admin/users/:userId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isAdmin) {
      return res.status(400).json({ error: 'Admin accounts cannot be deleted here' });
    }

    await Promise.all([
      Loan.deleteMany({ userId: user._id }),
      Payment.deleteMany({ userId: user._id }),
      Query.deleteMany({ userId: user._id }),
      Notification.deleteMany({ userId: user._id }),
      Message.deleteMany({
        $or: [
          { senderId: user._id },
          { recipientId: user._id }
        ]
      })
    ]);

    await user.deleteOne();

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin all loans
app.get('/admin/all-loans', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const loans = await Loan.find()
      .populate('userId', 'username email')
      .sort({ createdAt: -1 });
    res.json({ loans });
  } catch (err) {
    res.status(500).json({ error: 'Loans fetch failed' });
  }
});

// Admin payments (for invoices)
app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payments = await Payment.find()
      .populate('userId', 'username email')
      .populate('loanId', 'loanName bankName')
      .sort({ paymentDate: -1 });
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: 'Payments fetch failed' });
  }
});

// Approve payment
app.put('/admin/payment/:paymentId/approve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    payment.status = 'approved';
    payment.approvedAt = new Date();
    await payment.save();
    
    // Update loan balance if not already done
    const loan = await Loan.findById(payment.loanId);
    if (loan && loan.remainingBalance > 0) {
      loan.remainingBalance = Math.max(0, loan.remainingBalance - payment.amount);
      if (loan.remainingBalance === 0) {
        loan.status = 'paid';
      }
      await loan.save();
    }
    
    res.json({ message: 'Payment approved successfully', payment });
  } catch (err) {
    console.error('Approve payment error:', err);
    res.status(500).json({ error: 'Failed to approve payment' });
  }
});

// Reject payment
app.put('/admin/payment/:paymentId/reject', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    payment.status = 'rejected';
    payment.rejectionReason = req.body.reason || 'No reason provided';
    payment.rejectedAt = new Date();
    await payment.save();
    
    res.json({ message: 'Payment rejected', payment });
  } catch (err) {
    console.error('Reject payment error:', err);
    res.status(500).json({ error: 'Failed to reject payment' });
  }
});

// M-Pesa Invoice PDF
app.get('/admin/invoice/:paymentId/pdf', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId)
      .populate('userId', 'username email phoneNumber')
      .populate('loanId', 'loanName bankName');

    if (!payment || payment.paymentMethod !== 'mpesa') {
      return res.status(400).json({ error: 'Invalid payment' });
    }

    const doc = new PDFDocument();
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="mpesa-invoice-${payment._id}.pdf"`
    });

    doc.pipe(res);

    doc.fontSize(24).text('M-PESA RECEIPT', 50, 50);
    doc.fontSize(12)
      .text('Loan Reminder Platform', 50, 80)
      .text('support@loanreminder.com', 50, 95);

    doc.text(`Customer: ${payment.userId.username}`, 50, 140);
    doc.text(`Loan: ${payment.loanId.loanName}`, 50, 160);
    doc.text(`Amount: KSh ${payment.amount.toLocaleString()}`, 50, 180);
    doc.text(`Date: ${new Date(payment.paymentDate).toLocaleDateString()}`, 50, 200);
    doc.text('Payment Method: M-PESA', 50, 220);
    doc.text('Official Receipt - Thank you!', 50, 260);

    doc.end();
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// Support Queries Routes
app.post('/queries', verifyToken, async (req, res) => {
  try {
    const { category, subject, message, priority } = req.body;
    if (!category || !subject || !message) {
      return res.status(400).json({ error: 'Category, subject, and message required' });
    }

    const query = new Query({
      userId: req.user._id,
      category,
      subject,
      message,
      priority: priority || 'medium'
    });
    await query.save();

    res.json({ message: 'Query submitted successfully', query });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/queries', verifyToken, async (req, res) => {
  try {
    if (req.user.isAdmin) {
      const queries = await Query.find()
        .populate('userId', 'username email')
        .sort({ createdAt: -1 });
      return res.json({ queries });
    }
    
    const queries = await Query.find({ userId: req.user._id })
      .sort({ createdAt: -1 });
    res.json({ queries });
  } catch (err) {
    res.status(500).json({ error: 'Queries fetch failed' });
  }
});

// Admin respond to query
app.put('/admin/queries/:queryId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, message } = req.body;
    const query = await Query.findById(req.params.queryId);

    if (!query) {
      return res.status(404).json({ error: 'Query not found' });
    }

    if (status) query.status = status;
    if (message) {
      query.adminResponse = {
        message,
        respondedAt: new Date(),
        respondedBy: req.user._id
      };
    }

    await query.save();
    res.json({ message: 'Query updated', query });
  } catch (err) {
    console.error('Update query error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.put('/queries/:queryId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, message } = req.body;
    const query = await Query.findById(req.params.queryId);

    if (!query) {
      return res.status(404).json({ error: 'Query not found' });
    }

    if (status) query.status = status;
    if (message) {
      query.adminResponse = {
        message,
        respondedAt: new Date(),
        respondedBy: req.user._id
      };
    }

    await query.save();
    res.json({ message: 'Query updated', query });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== MESSAGING API ROUTES ====================

// Send a new message
app.post('/api/messages', verifyToken, async (req, res) => {
  try {
    const { recipientId, subject, body, parentMessageId } = req.body;

    if (!recipientId || !subject || !body) {
      return res.status(400).json({ error: 'Recipient, subject, and message body required' });
    }

    // Verify recipient exists
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const message = new Message({
      senderId: req.user._id,
      recipientId,
      subject,
      body,
      parentMessageId: parentMessageId || null
    });

    await message.save();

    // Populate sender info for response
    const populatedMessage = await Message.findById(message._id)
      .populate('senderId', 'username email')
      .populate('recipientId', 'username email');

    res.json({ message: 'Message sent successfully', message: populatedMessage });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Get user's inbox (received messages)
app.get('/api/messages/inbox', verifyToken, async (req, res) => {
  try {
    const messages = await Message.find({ 
      recipientId: req.user._id,
      isDeleted: false 
    })
      .populate('senderId', 'username email')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ messages });
  } catch (err) {
    console.error('Get inbox error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

// Get user's sent messages
app.get('/api/messages/sent', verifyToken, async (req, res) => {
  try {
    const messages = await Message.find({ 
      senderId: req.user._id,
      isDeleted: false 
    })
      .populate('recipientId', 'username email')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ messages });
  } catch (err) {
    console.error('Get sent error:', err);
    res.status(500).json({ error: 'Failed to fetch sent messages' });
  }
});

// Get conversation thread (messages between two users)
app.get('/api/messages/conversation/:userId', verifyToken, async (req, res) => {
  try {
    const otherUserId = req.params.userId;

    const messages = await Message.find({
      isDeleted: false,
      $or: [
        { senderId: req.user._id, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: req.user._id }
      ]
    })
      .populate('senderId', 'username email')
      .populate('recipientId', 'username email')
      .sort({ createdAt: 1 });

    res.json({ messages });
  } catch (err) {
    console.error('Get conversation error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Get all conversations (grouped by user)
app.get('/api/messages/conversations', verifyToken, async (req, res) => {
  try {
    // Get all messages where user is sender or recipient
    const allMessages = await Message.find({
      isDeleted: false,
      $or: [
        { senderId: req.user._id },
        { recipientId: req.user._id }
      ]
    })
      .populate('senderId', 'username email')
      .populate('recipientId', 'username email')
      .sort({ createdAt: -1 });

    // Group by conversation partner
    const conversationsMap = new Map();

    allMessages.forEach(msg => {
      const partner = msg.senderId._id.toString() === req.user._id.toString() 
        ? msg.recipientId 
        : msg.senderId;
      
      if (!partner) return;

      const partnerId = partner._id.toString();
      
      if (!conversationsMap.has(partnerId)) {
        conversationsMap.set(partnerId, {
          partner: {
            _id: partner._id,
            username: partner.username,
            email: partner.email
          },
          lastMessage: msg,
          unreadCount: 0
        });
      }

      // Count unread messages (received and not read)
      if (msg.recipientId._id.toString() === req.user._id.toString() && !msg.isRead) {
        conversationsMap.get(partnerId).unreadCount++;
      }
    });

    const conversations = Array.from(conversationsMap.values());
    res.json({ conversations });
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Mark message as read
app.put('/api/messages/:messageId/read', verifyToken, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.messageId,
      recipientId: req.user._id
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    message.isRead = true;
    await message.save();

    res.json({ message: 'Message marked as read' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Mark all messages from a conversation as read
app.put('/api/messages/read-all/:userId', verifyToken, async (req, res) => {
  try {
    const otherUserId = req.params.userId;

    await Message.updateMany(
      {
        senderId: otherUserId,
        recipientId: req.user._id,
        isRead: false
      },
      { isRead: true }
    );

    res.json({ message: 'All messages marked as read' });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Delete message (soft delete)
app.delete('/api/messages/:messageId', verifyToken, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.messageId,
      $or: [
        { senderId: req.user._id },
        { recipientId: req.user._id }
      ]
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    message.isDeleted = true;
    await message.save();

    res.json({ message: 'Message deleted' });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Get unread message count
app.get('/api/messages/unread-count', verifyToken, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      recipientId: req.user._id,
      isRead: false,
      isDeleted: false
    });

    res.json({ count });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Admin: Get all users for messaging
app.get('/admin/messaging/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find({ isAdmin: false })
      .select('username email createdAt')
      .sort({ createdAt: -1 });

    res.json({ users });
  } catch (err) {
    console.error('Get users for messaging error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Admin: Get sent notifications/reminders
app.get('/admin/notifications', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const notifications = await Notification.find()
      .populate('userId', 'username email')
      .populate('loanId', 'loanName bankName dueDate')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ notifications });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ==================== END MESSAGING ROUTES ====================

// ==================== ADMIN REPORTS ROUTES ====================

// Admin: Get revenue report
app.get('/api/admin/reports/revenue', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Get all approved payments
    const payments = await Payment.find({
      status: 'approved',
      createdAt: { $gte: start, $lte: end }
    }).populate('loanId');

    // Calculate total revenue (interest collected)
    const totalRevenue = payments.reduce((sum, payment) => {
      const loan = payment.loanId;
      if (loan && loan.interestRate) {
        const interestAmount = (loan.loanAmount * loan.interestRate) / 100;
        sum += (payment.amount / loan.totalAmount) * interestAmount;
      }
      return sum;
    }, 0);

    // Group by month for chart
    const monthlyData = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(end.getFullYear(), end.getMonth() - i, 1);
      const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
      const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
      
      const monthPayments = payments.filter(p => 
        p.createdAt >= monthStart && p.createdAt <= monthEnd
      );
      
      const monthRevenue = monthPayments.reduce((sum, payment) => {
        const loan = payment.loanId;
        if (loan && loan.interestRate) {
          const interestAmount = (loan.loanAmount * loan.interestRate) / 100;
          sum += (payment.amount / loan.totalAmount) * interestAmount;
        }
        return sum;
      }, 0);
      
      monthlyData.push({
        label: monthNames[monthDate.getMonth()],
        value: Math.round(monthRevenue)
      });
    }

    res.json({ totalRevenue, monthlyData });
  } catch (err) {
    console.error('Revenue report error:', err);
    res.status(500).json({ error: 'Failed to fetch revenue report' });
  }
});

// Admin: Get loans report
app.get('/api/admin/reports/loans', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const totalLoans = await Loan.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    const activeLoans = await Loan.countDocuments({
      status: { $in: ['active', 'approved'] },
      createdAt: { $gte: start, $lte: end }
    });

    const completedLoans = await Loan.countDocuments({
      status: 'paid',
      createdAt: { $gte: start, $lte: end }
    });

    const defaultedLoans = await Loan.countDocuments({
      status: 'defaulted',
      createdAt: { $gte: start, $lte: end }
    });

    const statusData = [
      { label: 'Active', value: activeLoans },
      { label: 'Completed', value: completedLoans },
      { label: 'Defaulted', value: defaultedLoans }
    ];

    res.json({ totalLoans, statusData });
  } catch (err) {
    console.error('Loans report error:', err);
    res.status(500).json({ error: 'Failed to fetch loans report' });
  }
});

// Admin: Get payments report
app.get('/api/admin/reports/payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const totalPayments = await Payment.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    const pendingPayments = await Payment.countDocuments({
      status: 'pending',
      createdAt: { $gte: start, $lte: end }
    });

    const approvedPayments = await Payment.countDocuments({
      status: 'approved',
      createdAt: { $gte: start, $lte: end }
    });

    const statusData = [
      { label: 'Pending', value: pendingPayments },
      { label: 'Completed', value: approvedPayments }
    ];

    res.json({ totalPayments, statusData });
  } catch (err) {
    console.error('Payments report error:', err);
    res.status(500).json({ error: 'Failed to fetch payments report' });
  }
});

// Admin: Get users report
app.get('/api/admin/reports/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const totalUsers = await User.countDocuments({ isAdmin: false });

    const monthlyData = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(end.getFullYear(), end.getMonth() - i, 1);
      const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
      const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
      
      const monthUsers = await User.countDocuments({
        isAdmin: false,
        createdAt: { $gte: monthStart, $lte: monthEnd }
      });
      
      monthlyData.push({
        label: monthNames[monthDate.getMonth()],
        value: monthUsers
      });
    }

    res.json({ totalUsers, monthlyData });
  } catch (err) {
    console.error('Users report error:', err);
    res.status(500).json({ error: 'Failed to fetch users report' });
  }
});

// Admin: Get top loans
app.get('/api/admin/reports/top-loans', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const loans = await Loan.find()
      .populate('userId', 'username email')
      .sort({ loanAmount: -1 })
      .limit(10);

    const topLoans = loans.map(loan => ({
      borrowerName: loan.userId?.username || 'Unknown',
      amount: loan.loanAmount,
      interest: loan.interestRate,
      status: loan.status,
      progress: loan.totalAmount > 0 ? Math.round(((loan.totalAmount - loan.remainingBalance) / loan.totalAmount) * 100) : 0,
      dueDate: loan.dueDate
    }));

    res.json({ loans: topLoans });
  } catch (err) {
    console.error('Top loans error:', err);
    res.status(500).json({ error: 'Failed to fetch top loans' });
  }
});

// Admin: Get monthly metrics
app.get('/api/admin/reports/monthly-metrics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Total disbursed (loans created this month)
    const totalDisbursed = await Loan.aggregate([
      { $match: { createdAt: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: null, total: { $sum: '$loanAmount' } } }
    ]);

    // Total collected (approved payments this month)
    const totalCollected = await Payment.aggregate([
      { $match: { status: 'approved', createdAt: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    // Outstanding balance
    const outstandingBalance = await Loan.aggregate([
      { $match: { status: { $in: ['active', 'approved'] } } },
      { $group: { _id: null, total: { $sum: '$remainingBalance' } } }
    ]);

    // Average loan size
    const avgLoanData = await Loan.aggregate([
      { $group: { _id: null, avg: { $avg: '$loanAmount' } } }
    ]);

    // Repayment rate
    const totalLoans = await Loan.countDocuments();
    const paidLoans = await Loan.countDocuments({ status: 'paid' });
    const repaymentRate = totalLoans > 0 ? Math.round((paidLoans / totalLoans) * 100) : 0;

    res.json({
      totalDisbursed: totalDisbursed[0]?.total || 0,
      totalCollected: totalCollected[0]?.total || 0,
      outstandingBalance: outstandingBalance[0]?.total || 0,
      avgLoanSize: avgLoanData[0]?.avg || 0,
      repaymentRate
    });
  } catch (err) {
    console.error('Monthly metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch monthly metrics' });
  }
});

// ==================== END REPORTS ROUTES ====================

// Send Loan Creation Notification (SMS + Email)
async function sendLoanCreationNotification(user, loan) {
  try {
    const smsMessage = `Hi ${user.username}, your loan "${loan.loanName}" of KSh ${loan.loanAmount.toLocaleString()} from ${loan.bankName} has been added. Due date: ${loan.dueDate.toLocaleDateString()}. - Loan Reminder`;
    
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #10b981;">✅ Loan Added Successfully</h2>
        <p>Dear ${user.username},</p>
        <p>Your loan has been added to the Loan Reminder system:</p>
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Loan Name:</strong> ${loan.loanName}</p>
          <p><strong>Bank:</strong> ${loan.bankName}</p>
          <p><strong>Amount:</strong> KSh ${loan.loanAmount.toLocaleString()}</p>
          <p><strong>Due Date:</strong> ${loan.dueDate.toLocaleDateString()}</p>
          <p><strong>Interest Rate:</strong> ${loan.interestRate}%</p>
        </div>
        <p style="color: #666;">We'll send you reminders before the due date!</p>
        <p style="font-size: 12px; color: #999;">© 2026 Loan Reminder. All rights reserved.</p>
      </div>
    `;

    const results = await Promise.allSettled([
      user.phoneNumber ? sendSMS(user.phoneNumber, smsMessage) : Promise.resolve({ success: false, error: 'No phone' }),
      user.email ? sendEmail(user.email, `Loan Added: ${loan.loanName}`, emailHtml) : Promise.resolve({ success: false, error: 'No email' }),
      sendInAppNotification(user._id, loan._id, 'loan_created', smsMessage),
    ]);

    console.log('📬 Loan creation notification sent for loan:', loan._id);
    return { success: true, results };
  } catch (error) {
    console.error('❌ Send loan creation notification error:', error.message);
    return { success: false, error: error.message };
  }
}

// Basic loan/payment routes
app.post('/add-loan', verifyToken, async (req, res) => {
  try {
    const { loanName, loanAmount, bankName, dueDate, interestRate, phoneNumber } = req.body;

    if (!loanName || !loanAmount || !bankName || !dueDate) {
      return res.status(400).json({ error: 'All loan fields required' });
    }

    const normalizedPhoneNumber = phoneNumber ? normalizePhoneNumber(phoneNumber) : '';
    if (phoneNumber && !normalizedPhoneNumber) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    const loan = new Loan({
      loanName,
      loanAmount: parseFloat(loanAmount),
      bankName,
      dueDate: new Date(dueDate),
      interestRate: interestRate ? parseFloat(interestRate) : 0,
      userId: req.user._id
    });
    await loan.save();

    // Get user details for notification
    const user = await User.findById(req.user._id);
    if (user) {
      if (normalizedPhoneNumber && normalizedPhoneNumber !== user.phoneNumber) {
        user.phoneNumber = normalizedPhoneNumber;
        await user.save();
      }

      // Send notifications in background (don't wait)
      sendLoanCreationNotification(user, loan).catch(err => {
        console.error('Failed to send loan creation notification:', err);
      });
    }

    res.json({ message: 'Loan added successfully', loan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/loans', verifyToken, async (req, res) => {
  try {
    const loans = await Loan.find({ userId: req.user._id })
      .sort({ dueDate: 1, createdAt: -1 });
    res.json({ loans });
  } catch (err) {
    res.status(500).json({ error: 'Loans fetch failed' });
  }
});

app.put('/loans/:loanId', verifyToken, async (req, res) => {
  try {
    const { status, remainingBalance } = req.body;
    const loan = await Loan.findOne({ _id: req.params.loanId, userId: req.user._id });
    
    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    if (status) loan.status = status;
    if (remainingBalance !== undefined) loan.remainingBalance = remainingBalance;
    
    await loan.save();
    res.json({ message: 'Loan updated', loan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/loans/:loanId', verifyToken, async (req, res) => {
  try {
    const loan = await Loan.findOneAndDelete({ _id: req.params.loanId, userId: req.user._id });
    
    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }
    
    res.json({ message: 'Loan deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/payments', verifyToken, async (req, res) => {
  try {
    const { loanId, amount, paymentMethod, status = 'pending', rejectionReason } = req.body;

    if (!loanId || !amount) {
      return res.status(400).json({ error: 'Loan ID and amount required' });
    }

    const loan = await Loan.findOne({ _id: loanId, userId: req.user._id });
    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    const initialBalance = loan.remainingBalance;
    const paymentAmount = parseFloat(amount);

    // Create payment record - ALWAYS starts as pending for admin approval
    const payment = new Payment({
      userId: req.user._id,
      loanId,
      amount: paymentAmount,
      paymentMethod: paymentMethod || 'mpesa',
      status: 'pending',  // Always pending until admin approves
      rejectionReason: '',
      initialBalance: initialBalance  // Store initial balance for reference
    });

    await payment.save();

    console.log(`⏳ Payment submitted - Awaiting admin approval: KSh ${paymentAmount}`);

    res.json({
      message: 'Payment submitted for admin approval',
      payment,
      initialBalance: initialBalance,
      newBalance: initialBalance,  // Balance unchanged until approved
      status: 'pending',
      note: 'Admin must approve this payment before balance is updated'
    });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/payments', verifyToken, async (req, res) => {
  try {
    const payments = await Payment.find({ userId: req.user._id })
      .populate('loanId', 'loanName bankName')
      .sort({ paymentDate: -1 });
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: 'Payments fetch failed' });
  }
});

// ==================== M-PESA DARAJA API ROUTES ====================

// Get M-Pesa Access Token
async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    const response = await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('M-Pesa Token Error:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

// Generate M-Pesa Password
function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const data = `${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`;
  return { password: Buffer.from(data).toString('base64'), timestamp };
}

// Initiate M-Pesa STK Push
app.post('/api/mpesa/stkpush', verifyToken, async (req, res) => {
  try {
    const { phoneNumber, amount, loanId } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'Phone number and amount required' });
    }

    const accessToken = await getMpesaAccessToken();
    const { password, timestamp } = generateMpesaPassword();

    // Format phone number
    const formattedPhone = phoneNumber.replace('+', '').startsWith('254')
      ? phoneNumber.replace('+', '')
      : `254${phoneNumber.replace('+', '')}`;

    const requestBody = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: `Loan${loanId || 'Payment'}`,
      TransactionDesc: 'Loan Payment'
    };

    console.log('STK Push Request:', requestBody);

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('STK Push Response:', response.data);

    // Create pending payment record
    if (loanId) {
      const loan = await Loan.findOne({ _id: loanId, userId: req.user._id });
      if (loan) {
        const payment = new Payment({
          userId: req.user._id,
          loanId,
          amount: parseFloat(amount),
          paymentMethod: 'mpesa',
          status: 'pending',
          mpesaCheckoutRequestID: response.data.CheckoutRequestID
        });
        await payment.save();
      }
    }

    res.json({
      success: response.data.ResponseCode === '0',
      message: response.data.ResponseDescription || 'STK Push sent',
      checkoutRequestID: response.data.CheckoutRequestID,
      data: response.data
    });
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    res.status(400).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Failed to initiate STK Push',
      error: error.message
    });
  }
});

// M-Pesa Callback Endpoint (Receives responses from Safaricom)
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const callbackData = req.body;
    console.log('📱 M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

    const { Body } = callbackData;
    const { stkCallback } = Body;

    const checkoutRequestID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    if (resultCode === 0) {
      // Payment successful from Safaricom
      const callbackMetadata = stkCallback.CallbackMetadata || {};
      const items = callbackMetadata.Item || [];
      const transactionData = {};

      items.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') transactionData.receiptNumber = item.Value;
        else if (item.Name === 'Amount') transactionData.amount = item.Value;
        else if (item.Name === 'PhoneNumber') transactionData.phoneNumber = item.Value;
        else if (item.Name === 'TransactionDate') transactionData.transactionDate = item.Value;
      });

      console.log('✅ M-Pesa Payment CONFIRMED by Safaricom:', transactionData);

      // Find and update payment record
      Payment.findOne({ mpesaCheckoutRequestID: checkoutRequestID }).then(async (payment) => {
        if (payment) {
          // Check if already confirmed to avoid double-processing
          if (payment.status === 'approved') {
            console.log('⚠️ Payment already confirmed, skipping');
          } else {
            // Update payment with Safaricom confirmation
            payment.status = 'approved';
            payment.mpesaReceiptNumber = transactionData.receiptNumber;
            payment.mpesaPhoneNumber = transactionData.phoneNumber;
            payment.approvedAt = new Date();
            await payment.save();

            // Update loan balance
            const loan = await Loan.findById(payment.loanId);
            if (loan) {
              const oldBalance = loan.remainingBalance;
              loan.remainingBalance = Math.max(0, oldBalance - payment.amount);
              if (loan.remainingBalance === 0) {
                loan.status = 'paid';
              }
              await loan.save();
              console.log(`✅ Loan balance updated: ${oldBalance} → ${loan.remainingBalance}`);
            }

            console.log('✅ Payment confirmed and loan balance updated!');
          }
        } else {
          console.log('❌ Payment not found for checkoutRequestID:', checkoutRequestID);
        }
      });

    } else {
      // Payment failed/cancelled
      console.log('❌ M-Pesa Payment FAILED:', { checkoutRequestID, resultCode, resultDesc });

      Payment.findOneAndUpdate(
        { mpesaCheckoutRequestID: checkoutRequestID },
        { 
          status: 'rejected', 
          rejectionReason: resultDesc,
          rejectedAt: new Date()
        }
      ).then(() => {
        console.log('✅ Payment marked as rejected');
      });
    }

    // Always respond with 200 to Safaricom
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('❌ Callback Handler Error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// Check M-Pesa Payment Status
app.post('/api/mpesa/check-status', verifyToken, async (req, res) => {
  try {
    const { checkoutRequestID } = req.body;

    if (!checkoutRequestID) {
      return res.status(400).json({ error: 'CheckoutRequestID required' });
    }

    const accessToken = await getMpesaAccessToken();
    const { password, timestamp } = generateMpesaPassword();

    const requestBody = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestID
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: response.data.ResponseCode === '0',
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc,
      data: response.data
    });
  } catch (error) {
    console.error('Status Check Error:', error.response?.data || error.message);
    res.status(400).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Failed to check status',
      error: error.message
    });
  }
});

// ==================== END M-PESA ROUTES ====================

// ==================== LOAN REMINDER CRON JOBS ====================

// Send reminder notifications (SMS + Email) for a specific loan
async function sendLoanReminder(user, loan, reminderType) {
  try {
    const daysUntilDue = Math.ceil((loan.dueDate - new Date()) / (1000 * 60 * 60 * 24));
    
    const reminderMessages = {
      '2_days_before': `REMINDER: ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} (${loan.bankName}) is due in 2 days (${loan.dueDate.toLocaleDateString()}). Please prepare for payment. - Loan Reminder`,
      'due_date': `DUE TODAY: ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} (${loan.bankName}) is due TODAY (${loan.dueDate.toLocaleDateString()}). Please make the payment immediately to avoid penalties. - Loan Reminder`,
      'overdue': `OVERDUE: ${user.username}, your loan payment of KSh ${loan.loanAmount.toLocaleString()} for ${loan.loanName} (${loan.bankName}) was due on ${loan.dueDate.toLocaleDateString()}. Please pay immediately to avoid additional charges. - Loan Reminder`,
    };

    const message = reminderMessages[reminderType] || `Payment Reminder: ${loan.loanName} - KSh ${loan.loanAmount.toLocaleString()} due ${loan.dueDate.toLocaleDateString()}`;

    const emailTemplates = {
      '2_days_before': `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #f59e0b;">⏰ Payment Reminder - 2 Days Left</h2>
          <p>Dear ${user.username},</p>
          <p>This is a friendly reminder that your loan payment is due in <strong>2 days</strong>:</p>
          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <p><strong>Loan Name:</strong> ${loan.loanName}</p>
            <p><strong>Bank:</strong> ${loan.bankName}</p>
            <p><strong>Amount Due:</strong> KSh ${loan.loanAmount.toLocaleString()}</p>
            <p><strong>Due Date:</strong> ${loan.dueDate.toLocaleDateString()}</p>
          </div>
          <p style="color: #666;">Please ensure you make the payment on time to avoid penalties.</p>
          <p style="font-size: 12px; color: #999;">© 2026 Loan Reminder. All rights reserved.</p>
        </div>
      `,
      'due_date': `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">🚨 PAYMENT DUE TODAY!</h2>
          <p>Dear ${user.username},</p>
          <p style="font-size: 18px; font-weight: bold; color: #ef4444;">Your loan payment is due TODAY!</p>
          <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
            <p><strong>Loan Name:</strong> ${loan.loanName}</p>
            <p><strong>Bank:</strong> ${loan.bankName}</p>
            <p><strong>Amount Due:</strong> KSh ${loan.loanAmount.toLocaleString()}</p>
            <p><strong>Due Date:</strong> ${loan.dueDate.toLocaleDateString()} (TODAY)</p>
          </div>
          <p style="color: #666;">Please make the payment immediately to avoid penalties and additional charges.</p>
          <p style="font-size: 12px; color: #999;">© 2026 Loan Reminder. All rights reserved.</p>
        </div>
      `,
      'overdue': `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc2626;">⚠️ OVERDUE PAYMENT NOTICE</h2>
          <p>Dear ${user.username},</p>
          <p style="font-size: 18px; font-weight: bold; color: #dc2626;">Your loan payment is OVERDUE!</p>
          <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <p><strong>Loan Name:</strong> ${loan.loanName}</p>
            <p><strong>Bank:</strong> ${loan.bankName}</p>
            <p><strong>Amount Due:</strong> KSh ${loan.loanAmount.toLocaleString()}</p>
            <p><strong>Original Due Date:</strong> ${loan.dueDate.toLocaleDateString()}</p>
          </div>
          <p style="color: #666;">Please make the payment IMMEDIATELY to avoid additional penalties and charges.</p>
          <p style="font-size: 12px; color: #999;">© 2026 Loan Reminder. All rights reserved.</p>
        </div>
      `,
    };

    const results = await Promise.allSettled([
      user.phoneNumber ? sendSMS(user.phoneNumber, message) : Promise.resolve({ success: false, error: 'No phone' }),
      user.email ? sendEmail(user.email, `Payment Reminder: ${loan.loanName}`, emailTemplates[reminderType] || emailTemplates['2_days_before']) : Promise.resolve({ success: false, error: 'No email' }),
      sendInAppNotification(user._id, loan._id, reminderType, message),
    ]);

    console.log(`📬 ${reminderType.replace('_', ' ').toUpperCase()} reminder sent for loan:`, loan._id, 'User:', user.username);
    return { success: true, results };
  } catch (error) {
    console.error('❌ Send loan reminder error:', error.message);
    return { success: false, error: error.message };
  }
}

// Track sent reminders to avoid duplicates
const sentReminders = new Set();

// Helper function to generate reminder key
function getReminderKey(loanId, reminderType) {
  return `${loanId}-${reminderType}`;
}

// Cron job: Send 2-days-before reminders (runs daily at 9 AM)
if (!process.env.VERCEL) {
cron.schedule('0 9 * * *', async () => {
  try {
    console.log('🕘 Running 2-days-before reminder cron job...');
    const now = new Date();
    const twoDaysFromNow = new Date(now);
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);
    twoDaysFromNow.setHours(23, 59, 59, 999);

    const loansDueIn2Days = await Loan.find({
      status: 'active',
      dueDate: {
        $gte: now,
        $lte: twoDaysFromNow
      }
    }).populate('userId');

    console.log(`📋 Found ${loansDueIn2Days.length} loans due in 2 days`);

    for (const loan of loansDueIn2Days) {
      const reminderKey = getReminderKey(loan._id, '2_days_before');
      
      // Skip if already sent
      if (sentReminders.has(reminderKey)) {
        console.log('⏭️ Reminder already sent for loan:', loan._id);
        continue;
      }

      if (loan.userId) {
        await sendLoanReminder(loan.userId, loan, '2_days_before');
        sentReminders.add(reminderKey);
      }
    }

    console.log('✅ 2-days-before reminders completed');
  } catch (err) {
    console.error('❌ 2-days-before cron job error:', err);
  }
});

// Cron job: Send due-date reminders (runs daily at 8 AM)
cron.schedule('0 8 * * *', async () => {
  try {
    console.log('🕗 Running due-date reminder cron job...');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setHours(23, 59, 59, 999);

    const loansDueToday = await Loan.find({
      status: 'active',
      dueDate: {
        $gte: todayStart,
        $lte: todayEnd
      }
    }).populate('userId');

    console.log(`📋 Found ${loansDueToday.length} loans due today`);

    for (const loan of loansDueToday) {
      const reminderKey = getReminderKey(loan._id, 'due_date');
      
      // Skip if already sent
      if (sentReminders.has(reminderKey)) {
        console.log('⏭️ Reminder already sent for loan:', loan._id);
        continue;
      }

      if (loan.userId) {
        await sendLoanReminder(loan.userId, loan, 'due_date');
        sentReminders.add(reminderKey);
      }
    }

    console.log('✅ Due-date reminders completed');
  } catch (err) {
    console.error('❌ Due-date cron job error:', err);
  }
});

// Cron job: Mark overdue loans and send overdue notifications (runs daily at 10 AM)
cron.schedule('0 10 * * *', async () => {
  try {
    console.log('🕙 Running overdue loan checker cron job...');
    const now = new Date();
    
    // Get loans that became overdue since last run
    const newlyOverdueLoans = await Loan.find({
      status: 'active',
      dueDate: { $lt: now }
    }).populate('userId');

    // Mark them as overdue
    await Loan.updateMany(
      { status: 'active', dueDate: { $lt: now } },
      { status: 'overdue' }
    );

    console.log(`📋 Marked ${newlyOverdueLoans.length} loans as overdue`);

    // Send overdue notifications
    for (const loan of newlyOverdueLoans) {
      const reminderKey = getReminderKey(loan._id, 'overdue');
      
      // Skip if already sent
      if (sentReminders.has(reminderKey)) {
        console.log('⏭️ Overdue reminder already sent for loan:', loan._id);
        continue;
      }

      if (loan.userId) {
        await sendLoanReminder(loan.userId, loan, 'overdue');
        sentReminders.add(reminderKey);
      }
    }

    console.log('✅ Overdue loans updated and notifications sent');
  } catch (err) {
    console.error('❌ Overdue cron job error:', err);
  }
});

// Cleanup old sent reminders (runs weekly on Sunday at midnight)
cron.schedule('0 0 * * 0', async () => {
  try {
    console.log('🧹 Cleaning up old sent reminders...');
    // Clear reminders older than 30 days (simple approach - clear all)
    sentReminders.clear();
    console.log('✅ Sent reminders cleared');
  } catch (err) {
    console.error('❌ Cleanup cron job error:', err);
  }
});
}

// ==================== END CRON JOBS ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

function logServerReady(port) {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log('📊 /stats/public - Live user count');
  console.log('🔐 POST /admin/create - Create admin (uses ADMIN_SECRET_KEY from .env)');
  console.log('👤 POST /login - Login');
  console.log('📝 POST /signup - Register');
  console.log('💡 Frontend ready: http://localhost:5500');
  console.log(`🔑 ADMIN_SECRET_KEY: ${ADMIN_SECRET_KEY.substring(0, 8)}...`);
}

function startServer(preferredPort, attemptsRemaining = 10) {
  const server = app.listen(preferredPort, () => {
    logServerReady(preferredPort);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsRemaining > 0) {
      const fallbackPort = Number(preferredPort) + 1;
      console.warn(`⚠️ Port ${preferredPort} is already in use. Retrying on ${fallbackPort}...`);
      startServer(fallbackPort, attemptsRemaining - 1);
      return;
    }

    console.error('Failed to start server:', error.message);
    process.exit(1);
  });
}

if (require.main === module) {
  startServer(Number(PORT));
}

module.exports = app;
