// M-Pesa Daraja API Integration
// Add this to server.js or create as separate file: mpesa.js

const axios = require('axios');
const crypto = require('crypto');

// M-Pesa Configuration - Credentials Injected
const MPESA_CONFIG = {
  consumerKey: '7nVWo6ncN6LVGKxz3bwjJhGcKTr8uO0Rj9ggRfPIq1G4XUYZ',
  consumerSecret: 'CjRNWO4T1yUAe3A3zg8NChqzGX2XBDOUA2erobevdkOCvgbiU1bQ7RlBAYNV44Rn',
  shortCode: '174379', // Test shortcode
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919', // Test passkey
  environment: 'sandbox', // 'sandbox' or 'production'
  callbackUrl: process.env.MPESA_CALLBACK_URL || 'https://your-domain.com/api/mpesa/callback'
};

// Base URLs
const MPESA_BASE_URL = MPESA.environment === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Generate M-Pesa Access Token
async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    
    const response = await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting M-Pesa token:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

// Generate Password for STK Push
function generatePassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const data = `${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`;
  return {
    password: Buffer.from(data).toString('base64'),
    timestamp: timestamp
  };
}

// Initiate STK Push
async function initiateSTKPush(phoneNumber, amount, accountReference, transactionDesc) {
  try {
    const accessToken = await getMpesaAccessToken();
    const { password, timestamp } = generatePassword();
    
    // Format phone number (remove +, ensure 254 format)
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
      AccountReference: accountReference || 'LoanPayment',
      TransactionDesc: transactionDesc || 'Loan Payment'
    };
    
    console.log('STK Push Request:', JSON.stringify(requestBody, null, 2));
    
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
    
    return {
      success: response.data.ResponseCode === '0',
      message: response.data.ResponseDescription || 'STK Push initiated',
      checkoutRequestID: response.data.CheckoutRequestID,
      merchantRequestID: response.data.MerchantRequestID,
      data: response.data
    };
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.errorMessage || 'Failed to initiate STK Push',
      error: error.message
    };
  }
}

// Query STK Push Status
async function querySTKStatus(checkoutRequestID) {
  try {
    const accessToken = await getMpesaAccessToken();
    const { password, timestamp } = generatePassword();
    
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
    
    return {
      success: response.data.ResponseCode === '0',
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc,
      data: response.data
    };
  } catch (error) {
    console.error('STK Status Query Error:', error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.errorMessage || 'Failed to query STK status',
      error: error.message
    };
  }
}

// M-Pesa Callback Handler (This receives callbacks from Safaricom)
function handleMpesaCallback(req, res) {
  try {
    const callbackData = req.body;
    console.log('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));
    
    const { Body } = callbackData;
    const { stkCallback } = Body;
    
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    
    // ResultCode 0 means success
    if (resultCode === 0) {
      const callbackMetadata = stkCallback.CallbackMetadata || {};
      const items = callbackMetadata.Item || [];
      
      // Extract transaction details
      const transactionData = {};
      items.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') {
          transactionData.receiptNumber = item.Value;
        } else if (item.Name === 'Amount') {
          transactionData.amount = item.Value;
        } else if (item.Name === 'PhoneNumber') {
          transactionData.phoneNumber = item.Value;
        } else if (item.Name === 'TransactionDate') {
          transactionData.transactionDate = item.Value;
        }
      });
      
      console.log('✅ Payment Successful:', transactionData);
      
      // TODO: Update your database with payment confirmation
      // - Mark payment as approved
      // - Update loan balance
      // - Send notification to user
      
    } else {
      console.log('❌ Payment Failed:', {
        checkoutRequestID,
        resultCode,
        resultDesc
      });
      
      // TODO: Update your database with payment failure
      // - Mark payment as rejected/failed
      // - Notify user
    }
    
    // Always respond with 200 to Safaricom
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('Callback Handler Error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
}

module.exports = {
  getMpesaAccessToken,
  initiateSTKPush,
  querySTKStatus,
  handleMpesaCallback,
  MPESA_CONFIG
};
