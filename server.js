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

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || crypto.randomBytes(32).toString('hex');

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
  windowMs: 15 * 60 * 1000,
  max: 5, // limit auth attempts to 5 per window
  message: { error: 'Too many login attempts, please try again later' }
});

// Middleware
app.use(bodyParser.json({ limit: '10kb' }));
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use('/api', apiLimiter);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// MongoDB connection with retry
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/loanReminder')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Error:', err.message);
    process.exit(1);
  });

// SCHEMAS - with validation
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 30 },
  email: { type: String, lowercase: true, trim: true, match: [/^\S+@\S+\.\S+$/, 'Invalid email'] },
  password: { type: String, required: true, minlength: 6 },
  isAdmin: { type: Boolean, default: false },
  phoneNumber: String,
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

// AUTH MIDDLEWARE
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ error: 'User not found' });

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
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
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
      password: hashedPassword
    });
    await user.save();

    const token = jwt.sign({ id: user._id, username: user.username, isAdmin: false }, JWT_SECRET);
    res.json({ message: 'Account created successfully', token, user: { username: user.username, isAdmin: false } });
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
    res.json({ token, user: { username: user.username, isAdmin: user.isAdmin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
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

// Basic loan/payment routes
app.post('/add-loan', verifyToken, async (req, res) => {
  try {
    const { loanName, loanAmount, bankName, dueDate, interestRate } = req.body;
    
    if (!loanName || !loanAmount || !bankName || !dueDate) {
      return res.status(400).json({ error: 'All loan fields required' });
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

// Overdue loan checker (cron job - runs daily at midnight)
cron.schedule('0 0 * * *', async () => {
  try {
    const now = new Date();
    await Loan.updateMany(
      { status: 'active', dueDate: { $lt: now } },
      { status: 'overdue' }
    );
    console.log('✅ Overdue loans updated');
  } catch (err) {
    console.error('❌ Cron job error:', err);
  }
});

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

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📊 /stats/public - Live user count');
  console.log('🔐 POST /admin/create - Create admin (uses ADMIN_SECRET_KEY from .env)');
  console.log('👤 POST /login - Login');
  console.log('📝 POST /signup - Register');
  console.log('💡 Frontend ready: http://localhost:5500');
  console.log(`🔑 ADMIN_SECRET_KEY: ${ADMIN_SECRET_KEY.substring(0, 8)}...`);
});

module.exports = app;
