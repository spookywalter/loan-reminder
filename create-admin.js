// Script to create an admin user
// Run: node create-admin.js

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/loanReminder';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'change_this_secret_key_before_production_deploy_2026';

async function createAdmin() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const username = process.argv[2] || 'admin';
    const password = process.argv[3] || 'admin123';
    const email = process.argv[4] || 'admin@example.com';

    // Check if user already exists
    const existingUser = await mongoose.connection.db.collection('users').findOne({ username: username.toLowerCase() });

    if (existingUser) {
      // Update existing user to admin
      await mongoose.connection.db.collection('users').updateOne(
        { username: username.toLowerCase() },
        { $set: { isAdmin: true } }
      );
      console.log(`✅ User "${username}" has been promoted to admin!`);
    } else {
      // Create new admin user
      const hashedPassword = await bcrypt.hash(password, 12);

      const adminUser = {
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        password: hashedPassword,
        isAdmin: true,
        createdAt: new Date()
      };

      await mongoose.connection.db.collection('users').insertOne(adminUser);
      console.log(`✅ Admin user "${username}" created successfully!`);
    }

    console.log('\n========== LOGIN CREDENTIALS ==========');
    console.log(`Username: ${username}`);
    console.log(`Password: ${password}`);
    console.log('======================================\n');
    console.log('Admin Features:');
    console.log('- GET /admin/stats - View system statistics');
    console.log('- GET /admin/users - View all users');
    console.log('- GET /admin/all-loans - View all loans');
    console.log('- GET /admin/all-payments - View all payments');
    console.log('- GET /admin/invoice/:id/pdf - Download M-Pesa invoice');
    console.log('\n⚠️  ADMIN_SECRET_KEY from .env:', ADMIN_SECRET_KEY.substring(0, 12) + '...');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

createAdmin();
