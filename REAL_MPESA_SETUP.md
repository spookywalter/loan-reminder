# 🚀 REAL M-Pesa STK Push Setup Guide

## ⚠️ IMPORTANT: Sandbox vs Production

### Current Status: SANDBOX (Testing)
- ❌ **NO real STK pushes** sent to phones
- ❌ **NO real money** charged
- ✅ Uses test credentials
- ✅ Auto-approves payments

### To Get REAL STK Pushes: PRODUCTION Required
- ✅ **REAL STK pushes** sent to phones
- ✅ **REAL money** charged from M-Pesa
- ✅ Uses production credentials
- ✅ Actual payment confirmation from Safaricom

---

## 📋 Requirements for Production

### 1. Business Requirements
- ✅ Registered company in Kenya (Certificate of Incorporation)
- ✅ M-Pesa Paybill or Till Number (active merchant account)
- ✅ Company bank account
- ✅ KRA PIN Compliance
- ✅ Director's ID copies

### 2. Technical Requirements
- ✅ **Domain name** with SSL (HTTPS) - e.g., https://your-loan-app.com
- ✅ **Public server** or hosting (not localhost)
- ✅ **Callback URL** accessible from internet
- ✅ **Node.js server** running 24/7

### 3. Daraja Account Requirements
- ✅ Approved Daraja production account
- ✅ Production credentials (different from sandbox)
- ✅ M-Pesa Express product activated

---

## 🚀 Step-by-Step Setup

### Step 1: Get Production Credentials

#### Option A: Already Have Safaricom Merchant Account
1. Login to https://developer.safaricom.co.ke/
2. Go to "My Apps"
3. Click "Go Live" on your app
4. Submit required documents:
   - Certificate of Incorporation
   - Director's ID
   - KRA PIN
   - M-Pesa Paybill proof
5. Wait for approval (3-5 business days)
6. Receive production credentials:
   - **Consumer Key** (production)
   - **Consumer Secret** (production)
   - **Shortcode** (your Paybill number)
   - **Passkey** (unique to your account)

#### Option B: New to M-Pesa
1. Visit Safaricom M-Pesa merchant page
2. Apply for M-Pesa Paybill/Till Number
3. Complete business registration
4. Wait for activation (1-2 weeks)
5. Then follow Option A

### Step 2: Setup Production Server

#### You Need:
- **Domain:** https://your-loan-app.com
- **Hosting:** AWS, DigitalOcean, Heroku, or local Kenyan hosting
- **SSL Certificate:** HTTPS enabled (Let's Encrypt is free)

#### Deploy Your App:
```bash
# Example: Deploy to production server
git push production main
npm install
npm start
```

### Step 3: Configure Callback URL

#### Callback URL Must Be:
- ✅ Publicly accessible (HTTPS)
- ✅ Not localhost or ngrok
- ✅ Example: https://your-loan-app.com/api/mpesa/callback

#### Update .env:
```env
MPESA_CALLBACK_URL=https://your-loan-app.com/api/mpesa/callback
```

### Step 4: Update Production Credentials

Edit `.env` file:
```env
# PRODUCTION - REAL MONEY
MPESA_CONSUMER_KEY=your_production_key_here
MPESA_CONSUMER_SECRET=your_production_secret_here
MPESA_SHORTCODE=your_paybill_number_here
MPESA_PASSKEY=your_production_passkey_here
MPESA_ENVIRONMENT=production
MPESA_CALLBACK_URL=https://your-loan-app.com/api/mpesa/callback
```

### Step 5: Test with Small Amount

1. Deploy updated code
2. Restart server
3. Go to Quick Pay page
4. Enter phone: **Your real M-Pesa number**
5. Enter amount: **KSh 1** (minimum test)
6. Click Confirm Payment

### What Should Happen:

```
1. You receive REAL STK push on your phone
   ┌─────────────────────────────────┐
   │ M-Pesa Payment                  │
   │                                 │
   │ Pay KSh 1.00 to Loan Reminder   │
   │                                 │
   │ Enter PIN to confirm            │
   │                                 │
   │ 1. Enter PIN    2. Cancel       │
   └─────────────────────────────────┘

2. Enter your M-Pesa PIN

3. Payment processed by Safaricom

4. Callback sent to your server:
   POST https://your-loan-app.com/api/mpesa/callback
   {
     "Body": {
       "stkCallback": {
         "MerchantRequestID": "...",
         "CheckoutRequestID": "...",
         "ResultCode": 0,
         "ResultDesc": "The service request is processed successfully.",
         "CallbackMetadata": {
           "Item": [
             {"Name": "Amount", "Value": 1},
             {"Name": "MpesaReceiptNumber", "Value": "RGH1234567890"},
             {"Name": "TransactionDate", "Value": 20260324120000},
             {"Name": "PhoneNumber", "Value": "254712345678"}
           ]
         }
       }
     }
   }

5. Your server updates database:
   - Payment status: "approved"
   - M-Pesa receipt: RGH1234567890
   - Loan balance reduced

6. User sees confirmation on website
```

---

## 🔧 Current Code is Production-Ready!

Your code already supports production! Just need to:

1. **Get production credentials** from Safaricom
2. **Deploy to production server** with HTTPS
3. **Update .env** with production values
4. **Test with real phone number**

---

## 🧪 Testing in Production

### Test Phone Numbers (REAL M-Pesa):
Use **your actual M-Pesa registered number**:
- Format: `2547XXXXXXXX` or `2541XXXXXXXX`
- Must be registered with M-Pesa
- Must have sufficient balance

### Test Flow:
```
1. User enters: 254712345678
2. User enters amount: 1
3. Click "Confirm Payment"
4. REAL STK push sent to 254712345678
5. User enters PIN on phone
6. KSh 1 deducted from M-Pesa
7. Payment confirmed via callback
8. Loan balance updated
9. User receives SMS from M-Pesa
```

---

## 📊 Production vs Sandbox Comparison

| Feature | Sandbox | Production |
|---------|---------|------------|
| STK Push Sent | ❌ No | ✅ Yes (Real) |
| Money Charged | ❌ No | ✅ Yes (Real) |
| Phone Number | Test only | Real M-Pesa |
| Credentials | Test keys | Production keys |
| Callback | Simulated | Real from Safaricom |
| Receipt Number | Fake | Real M-Pesa receipt |
| Environment | `sandbox` | `production` |
| Cost | Free | Transaction fees apply |

---

## ⚠️ Important Notes

### Security:
- ✅ **NEVER commit .env** to Git
- ✅ Use **HTTPS only** in production
- ✅ Validate all callbacks from Safaricom
- ✅ Log all transactions
- ✅ Use environment variables

### Costs:
- M-Pesa transaction fees apply
- Typical fees: KSh 10-50 per transaction
- Billed to your Paybill account

### Monitoring:
- Check Daraja portal for transactions
- Monitor callback logs
- Track failed payments
- Reconcile daily with M-Pesa statements

---

## 🆘 Troubleshooting

### "Invalid Credentials" Error:
- Check you're using **production** credentials (not sandbox)
- Verify credentials in Daraja portal
- Ensure app is approved for production

### "Invalid Callback URL" Error:
- URL must be **HTTPS** (not HTTP)
- URL must be publicly accessible
- Test URL in browser first

### STK Push Not Received:
- Check phone number format (2547...)
- Ensure phone has network coverage
- Verify M-Pesa is active on number
- Check if STK services are blocked

### Callback Not Received:
- Check server logs for incoming POST
- Verify firewall allows Safaricom IPs
- Test callback endpoint with Postman
- Check SSL certificate is valid

---

## 📞 Support Contacts

### Safaricom Daraja Support:
- **Email:** apisupport@safaricom.co.ke
- **Phone:** +254 700 123 456
- **Portal:** https://developer.safaricom.co.ke/support

### M-Pesa Merchant Support:
- **Email:** mpesa@safaricom.co.ke
- **Phone:** 100 (toll-free) or +254 722 000 100

---

## ✅ Checklist for Going Live

- [ ] Business registered in Kenya
- [ ] M-Pesa Paybill account active
- [ ] Daraja production account approved
- [ ] Production credentials received
- [ ] Domain with HTTPS setup
- [ ] Server deployed (not localhost)
- [ ] Callback URL configured
- [ ] .env updated with production values
- [ ] Tested with KSh 1
- [ ] Received real STK push
- [ ] Payment confirmed in database
- [ ] Monitoring logs daily

---

## 🎯 Quick Summary

**To get REAL STK pushes:**

1. **Get production credentials** from Safaricom (requires business registration)
2. **Deploy to production server** with HTTPS domain
3. **Update .env** with production values
4. **Test with your real M-Pesa number**
5. **Receive REAL STK push** on your phone!

**Your code is already production-ready!** Just need the credentials and deployment.

---

## 📚 Additional Resources

- [Daraja API Documentation](https://developer.safaricom.co.ke/APIs)
- [M-Pesa Express Guide](https://developer.safaricom.co.ke/M-Pesa/APIs)
- [Production Go-Live Guide](https://developer.safaricom.co.ke/M-Pesa/Documentation)
- [Postman Collection](https://developer.safaricom.co.ke/APIs/postman)
