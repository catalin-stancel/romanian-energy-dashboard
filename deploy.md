# Deployment Instructions

## Quick Deploy to Render.com

Follow these steps to deploy your Romanian Energy Balancing Market Dashboard to Render.com:

### Step 1: Create GitHub Repository

1. Go to [GitHub](https://github.com) and create a new repository
2. Name it `romanian-energy-dashboard` (or any name you prefer)
3. Make it public (required for Render.com free tier)
4. Don't initialize with README (we already have one)

### Step 2: Push Code to GitHub

Run these commands in your project directory:

```bash
git init
git add .
git commit -m "Initial commit - Romanian Energy Dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/romanian-energy-dashboard.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

### Step 3: Deploy to Render.com

1. Go to [Render.com](https://render.com) and sign up/login
2. Click "New +" and select "Blueprint"
3. Connect your GitHub account
4. Select your `romanian-energy-dashboard` repository
5. Render will automatically detect the `render.yaml` file
6. Click "Apply" to start deployment

### Step 4: Monitor Deployment

- Render will create 3 services:
  - PostgreSQL database
  - Web service (dashboard)
  - Worker service (data collector)
- Initial deployment takes 5-10 minutes
- You'll get a live URL like: `https://romanian-energy-dashboard.onrender.com`

### Step 5: Verify Deployment

1. Visit your live URL
2. Check that the dashboard loads
3. Verify data is being collected (may take 15 minutes for first data)
4. Test the auto-refresh functionality

## Environment Variables

The following environment variables are automatically configured:

- `RENDER=true` - Enables production mode
- `DATABASE_URL` - PostgreSQL connection (auto-generated)
- `PORT` - Application port (auto-generated)
- `ENTSOE_API_TOKEN` - Set to your API token

## Troubleshooting

### Common Issues:

1. **Build fails**: Check the build logs in Render dashboard
2. **Database connection errors**: Wait for database to be fully provisioned
3. **Worker not starting**: Check worker logs for API connection issues

### Logs Access:

- Web service logs: Render Dashboard → Services → romanian-energy-dashboard
- Worker logs: Render Dashboard → Services → romanian-energy-collector
- Database logs: Render Dashboard → Databases → romanian-energy-db

## Free Tier Limitations

Render.com free tier includes:
- ✅ 750 hours/month web service
- ✅ PostgreSQL database (90 days retention)
- ✅ Automatic deployments
- ✅ Custom domains
- ⚠️ Services sleep after 15 minutes of inactivity
- ⚠️ Cold start delay (30-60 seconds)

## Upgrading

To upgrade to paid plans for better performance:
1. Go to Render Dashboard
2. Select your services
3. Upgrade to "Starter" plan ($7/month per service)
4. Benefits: No sleeping, faster performance, longer database retention

## Support

If you encounter issues:
1. Check Render.com documentation
2. Review service logs
3. Verify GitHub repository is public
4. Ensure all files are committed and pushed
