# Loan Reminder Application

A full-stack loan management system with user authentication, loan tracking, payment history, and admin dashboard.

## Quick Start

### Prerequisites
1. **Node.js** - v16 or higher
2. **MongoDB** - Local installation or MongoDB Atlas

### Installation

```bash
# Install dependencies
npm install

# Configure environment (edit .env with your settings)
# - MONGODB_URI: Your MongoDB connection string
# - ADMIN_SECRET_KEY: Secret key for admin creation
# - JWT_SECRET: Secret for JWT tokens
```

### Running MongoDB

**Option 1: Local MongoDB**
```bash
# Start MongoDB service (Windows)
net start MongoDB

# Or run mongod directly
mongod --dbpath "C:\data\db"
```

**Option 2: MongoDB Atlas (Cloud)**
1. Go to https://www.mongodb.com/atlas/database
2. Create a free cluster
3. Get your connection string
4. Update `MONGODB_URI` in `.env`

### Start the Application

**Option A: Using VS Code (Recommended)**
1. Press `F5` to launch "Full Stack" configuration
2. This starts both backend (port 5000) and frontend (port 5500)
3. Browser opens automatically at http://localhost:5500

**Option B: Manual Start**
```bash
# Terminal 1 - Backend
npm run dev

# Terminal 2 - Frontend
node serve-frontend.js
```

### Create Admin User

```bash
# Using the script (recommended)
node create-admin.js admin password123 admin@example.com

# Or via API (uses ADMIN_SECRET_KEY from .env)
curl -X POST http://localhost:5000/admin/create \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123","email":"admin@example.com","secretKey":"change_this_secret_key_before_production_deploy_2026"}'
```

## API Endpoints

### Public Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/stats/public` | Get total user count |
| POST | `/signup` | Register new user |
| POST | `/login` | User login |
| POST | `/admin/create` | Create admin (requires secret key) |

### User Endpoints (Requires Authentication)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/loans` | Get user's loans |
| POST | `/add-loan` | Add new loan |
| PUT | `/loans/:id` | Update loan |
| DELETE | `/loans/:id` | Delete loan |
| GET | `/payments` | Get user's payments |
| POST | `/payments` | Record payment |
| GET | `/queries` | Get support queries |
| POST | `/queries` | Submit support query |

### Admin Endpoints (Requires Admin Token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/stats` | System statistics |
| GET | `/admin/users` | All users |
| GET | `/admin/all-loans` | All loans |
| GET | `/admin/all-payments` | All payments |
| GET | `/admin/invoice/:id/pdf` | Download M-Pesa invoice |
| PUT | `/queries/:id` | Update support query |

## Authentication

All protected endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <your_token>
```

## Project Structure

```
├── server.js           # Backend server (Express + MongoDB)
├── serve-frontend.js   # Frontend static file server
├── create-admin.js     # Admin user creation script
├── .env                # Environment variables (DO NOT COMMIT)
├── .env.example        # Example environment file
├── package.json        # Dependencies
└── .dist/
    └── frontend html/  # Frontend HTML files
        ├── index.html
        ├── login.html
        ├── sign-up.html
        ├── dashboard-new.html
        ├── admin-dashboard.html
        └── ...
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | 5000 |
| `MONGODB_URI` | MongoDB connection string | mongodb://127.0.0.1:27017/loanReminder |
| `JWT_SECRET` | Secret for JWT tokens | Auto-generated |
| `ADMIN_SECRET_KEY` | Secret for admin creation | Auto-generated |
| `NODE_ENV` | Environment (development/production) | development |

## Features

- ✅ User authentication (signup/login)
- ✅ Loan management (CRUD operations)
- ✅ Payment tracking
- ✅ Support query system
- ✅ Admin dashboard
- ✅ M-Pesa invoice PDF generation
- ✅ Overdue loan detection (daily cron job)
- ✅ Rate limiting for security
- ✅ Input validation
- ✅ Responsive UI

## Security Features

- Password hashing with bcrypt
- JWT-based authentication
- Rate limiting on auth endpoints
- Helmet.js security headers
- Input validation and sanitization
- CORS configuration

## Troubleshooting

**MongoDB Connection Error**
```bash
# Check if MongoDB is running
net start MongoDB

# Or check MongoDB status
mongosh --eval "db.adminCommand('ping')"
```

**Port Already in Use**
```bash
# Kill process on port 5000 (Windows)
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**Module Not Found**
```bash
npm install
```

**Login Not Working**
1. Check browser console for errors
2. Verify backend is running on port 5000
3. Check CORS settings in server.js
4. Ensure MongoDB is connected

## Development

```bash
# Run with auto-reload
npm run dev

# Run tests (when added)
npm test
```

## License

MIT License - See LICENSE file for details.

## Support

Email: support@loanreminder.com  
Phone: +254 700 123 456
"# loan-reminder" 
"# loan-reminder" 
