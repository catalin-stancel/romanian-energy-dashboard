# 🚀 Deploy Your Romanian Energy Dashboard NOW

Your app is ready to deploy! Follow these simple steps to get it online in under 10 minutes.

## Option 1: Railway.app (Recommended - Free & Easy)

### Step 1: Create GitHub Repository
1. Go to https://github.com/new
2. Repository name: `romanian-energy-dashboard`
3. Make it **Public**
4. **Don't** initialize with README (we have one)
5. Click **Create repository**

### Step 2: Push Your Code
Copy your GitHub username from the repository URL, then run these commands:

```bash
# Replace YOUR_USERNAME with your actual GitHub username
git remote set-url origin https://github.com/YOUR_USERNAME/romanian-energy-dashboard.git
git push -u origin main
```

### Step 3: Deploy on Railway
1. Go to https://railway.app
2. Click **Login with GitHub**
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your `romanian-energy-dashboard` repository
5. Railway will automatically detect the Dockerfile and start deploying!

### Step 4: Add Environment Variables
1. In Railway dashboard, click on your project
2. Go to **Variables** tab
3. Add these variables:
   - `ENTSOE_API_TOKEN`: `your_entsoe_api_token_here`
   - `PORT`: `8000`

### Step 5: Get Your Live URL
- Your app will be live at: `https://your-app-name.railway.app`
- Railway will show you the URL in the dashboard

---

## Option 2: Render.com (Alternative - Also Free)

### Step 1-2: Same as above (Create GitHub repo and push code)

### Step 3: Deploy on Render
1. Go to https://render.com
2. Click **Get Started for Free** → **GitHub**
3. Click **New** → **Web Service**
4. Connect your `romanian-energy-dashboard` repository

### Step 4: Configure Deployment
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `gunicorn -w 4 -k uvicorn.workers.UvicornWorker src.web.app:app --host 0.0.0.0 --port $PORT`
- **Environment Variables**:
  - `ENTSOE_API_TOKEN`: `your_entsoe_api_token_here`
  - `RENDER`: `true`

### Step 5: Deploy
- Click **Create Web Service**
- Your app will be live at: `https://your-app-name.onrender.com`

---

## 🎉 Your Dashboard Features

Once deployed, your dashboard will show:
- ⚡ Real-time Romanian energy balancing market data
- 📊 Power generation by source (hydro, wind, solar, etc.)
- 🔄 Import/export flows with neighboring countries
- 💰 Market prices and balancing costs
- 📈 Historical trends and analysis

## 🔧 Troubleshooting

**If deployment fails:**
1. Check that all environment variables are set correctly
2. Ensure your ENTSOE API token is valid
3. Check the deployment logs for specific errors

**Need your ENTSOE API token?**
1. Go to https://transparency.entsoe.eu/
2. Register for an account
3. Generate an API token in your profile

---

## 📞 Next Steps

1. **Deploy now** using one of the options above
2. **Test your live dashboard** - it should show real Romanian energy data
3. **Share the URL** - your dashboard is now publicly accessible!

The deployment process is automated and should complete in 5-10 minutes. Your Romanian Energy Balancing Market Dashboard will be live and updating with real-time data!
