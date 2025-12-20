# Visa Slot Checker - Puppeteer Server

Self-hosted Puppeteer server for checking US visa appointment slots.

## Deploy to Render.com (Recommended - $7/month)

1. Create a new GitHub repo and push this `puppeteer-server` folder
2. Go to [render.com](https://render.com) and create account
3. Click "New" → "Web Service"
4. Connect your GitHub repo
5. Settings:
   - **Environment**: Docker
   - **Plan**: Starter ($7/month)
6. Add environment variable:
   - `API_SECRET`: Generate a secure random string
7. Deploy!

## Deploy to Railway.app

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Add environment variable: `API_SECRET`
5. Deploy

## Local Testing

```bash
npm install
API_SECRET=test-secret node server.js
```

Test the endpoint:
```bash
curl -X POST http://localhost:3000/check-slots \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-secret" \
  -d '{"username":"your-username","password":"your-password","appd":"your-appd"}'
```

## API Endpoint

**POST /check-slots**

Headers:
- `Authorization: Bearer YOUR_API_SECRET`
- `Content-Type: application/json`

Body:
```json
{
  "username": "visa-account-username",
  "password": "visa-account-password", 
  "appd": "application-id"
}
```

Response:
```json
{
  "success": true,
  "slots": [...],
  "totalSlots": 42,
  "checkedAt": "2024-01-15T10:30:00.000Z"
}
```

## After Deployment

Copy your Render/Railway URL (e.g., `https://visa-slot-checker.onrender.com`) and add it as a secret in your Lovable project along with the API_SECRET.

