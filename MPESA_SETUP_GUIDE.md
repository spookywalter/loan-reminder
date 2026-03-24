# M-Pesa Daraja API Integration Guide

## Overview
This guide shows you how to integrate M-Pesa payments into your Loan Reminder application using Safaricom's Daraja API.

## Prerequisites

### 1. Create Safaricom Daraja Account
1. Go to https://developer.safaricom.co.ke/
2. Click "Create Account" or "Login"
3. Complete registration with your details
4. Verify your email

### 2. Create M-Pesa App
1. Login to Daraja Developer Portal
2. Go to "My Apps" → "Create New App"
3. Select **Sandbox** for testing (or Production for live)
4. Choose **M-Pesa Express API** (STK Push)
5. Fill in app details:
   - App Name: Loan Reminder
   - Description: Loan payment collection
6. Submit and get your credentials

### 3. Get Your Credentials
After creating the app, you'll receive:
- **Consumer Key** (e.g., `L7...`)
- **Consumer Secret** (e.g., `9A...`)
- **Shortcode** (Test: `174379`)
- **Passkey** (Test: `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919`)

## Setup Instructions

### Step 1: Update .env File
Open `.env` and replace the placeholder values:

```env
# M-Pesa Daraja API Credentials
MPESA_CONSUMER_KEY=your_actual_consumer_key_here
MPESA_CONSUMER_SECRET=your_actual_consumer_secret_here
MPESA_SHORTCODE=174379
MPESA_PASSKEY=your_actual_passkey_here
MPESA_ENVIRONMENT=sandbox
MPESA_CALLBACK_URL=https://your-domain.com/api/mpesa/callback
```

### Step 2: Install Required Package
```bash
npm install axios
```

### Step 3: Setup Callback URL (For Production)

For **Sandbox/Testing**, you can use:
- **ngrok** (recommended for local development)
- **localhost.run**
- Any tunneling service

#### Using ngrok:
```bash
# Install ngrok
npm install -g ngrok

# Start your server
node server.js

# In another terminal, expose port 5000
ngrok http 5000

# Copy the https URL (e.g., https://abc123.ngrok.io)
# Update .env:
MPESA_CALLBACK_URL=https://abc123.ngrok.io/api/mpesa/callback
```

### Step 4: Test M-Pesa Integration

#### Test STK Push:
```bash
curl -X POST http://localhost:5000/api/mpesa/stkpush \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -d '{
    "phoneNumber": "254712345678",
    "amount": 1,
    "loanId": "YOUR_LOAN_ID"
  }'
```

#### Expected Response:
```json
{
  "success": true,
  "message": "STK Push sent",
  "checkoutRequestID": "ws_CO_123456789",
  "data": {
    "ResponseCode": "0",
    "ResponseDescription": "Success"
  }
}
```

### Step 5: User Experience Flow

1. **User selects M-Pesa** on Quick Pay page
2. **Enters phone number** (e.g., 0712345678)
3. **Enters amount** to pay
4. **Clicks "Pay with M-Pesa"**
5. **STK Push sent** to user's phone
6. **User enters PIN** on phone prompt
7. **Payment processed** automatically
8. **Loan balance updated** in the system

## Testing

### Sandbox Test Credentials
- **Shortcode:** 174379
- **Passkey:** `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919`
- **Test Phone Numbers:**
  - `254708374149` - Success
  - `254708374148` - Insufficient funds
  - `254708374147` - Rejected

### Test Payment Flow
1. Login to your app
2. Go to Quick Pay
3. Select a loan
4. Choose M-Pesa payment method
5. Enter phone: `254708374149`
6. Enter amount: `1`
7. Click "Confirm Payment"
8. Check server console for STK Push response

## Going to Production

### Requirements:
1. **Business Registration** - Registered company in Kenya
2. **M-Pesa Paybill/Till** - Active M-Pesa merchant account
3. **SSL Certificate** - HTTPS for your domain
4. **Callback URL** - Publicly accessible HTTPS endpoint

### Production Steps:
1. Change `MPESA_ENVIRONMENT` to `production`
2. Update credentials with production values
3. Set `MPESA_CALLBACK_URL` to your production domain
4. Test with small amounts first
5. Monitor transactions in Daraja portal

## Troubleshooting

### Error: "Invalid Access Token"
- Check Consumer Key and Secret are correct
- Ensure you're using the right environment (sandbox/production)

### Error: "Request failed with status code 400"
- Verify phone number format (254XXXXXXXXX)
- Check amount is valid (> 0)
- Ensure shortcode and passkey match environment

### Error: "Callback not received"
- Verify callback URL is publicly accessible
- Check ngrok is running (if using for testing)
- Ensure firewall allows Safaricom callbacks

### STK Push not appearing on phone
- Check phone number is registered with M-Pesa
- Ensure phone has network coverage
- Verify STK Push isn't blocked on the number

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mpesa/stkpush` | POST | Initiate STK Push |
| `/api/mpesa/callback` | POST | Receive M-Pesa callbacks |
| `/api/mpesa/check-status` | POST | Check payment status |

## Support

- **Daraja Support:** https://developer.safaricom.co.ke/support
- **Email:** apisupport@safaricom.co.ke
- **Phone:** +254 700 123 456

## Security Best Practices

1. **Never commit .env** - Add to .gitignore
2. **Use HTTPS** - Always use SSL in production
3. **Validate callbacks** - Verify callback authenticity
4. **Log transactions** - Keep audit trail
5. **Rate limiting** - Prevent abuse of STK endpoint
6. **Token authentication** - Require valid JWT for all payment endpoints

## Additional Resources

- [Daraja API Docs](https://developer.safaricom.co.ke/APIs)
- [M-Pesa Express Guide](https://developer.safaricom.co.ke/M-Pesa/APIs)
- [Postman Collection](https://developer.safaricom.co.ke/APIs/postman)
