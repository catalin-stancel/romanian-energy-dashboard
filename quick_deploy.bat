@echo off
echo ========================================
echo Romanian Energy Dashboard Quick Deploy
echo ========================================
echo.

echo This will deploy your dashboard to a free hosting service.
echo The process takes about 5-10 minutes.
echo.

echo Step 1: Checking if you have a GitHub account...
echo.
echo Please go to: https://github.com/new
echo.
echo Create a repository with these settings:
echo - Repository name: romanian-energy-dashboard
echo - Make it PUBLIC (required for free hosting)
echo - Don't initialize with README
echo.
echo Press any key when you've created the repository...
pause >nul

echo.
echo Step 2: What's your GitHub username?
set /p username="GitHub username: "

echo.
echo Step 3: Pushing code to GitHub...
git remote remove origin 2>nul
git remote add origin https://github.com/%username%/romanian-energy-dashboard.git
git push -u origin main

if %errorlevel% neq 0 (
    echo.
    echo ❌ Push failed. Please check:
    echo - Repository exists and is public
    echo - You're logged into GitHub
    echo.
    echo Try running this manually:
    echo git push -u origin main --force
    echo.
    pause
    exit /b 1
)

echo.
echo ✅ Code pushed successfully!
echo.
echo Step 4: Deploying to Render.com...
echo.
echo Please go to: https://render.com
echo.
echo Follow these steps:
echo 1. Sign up/login (free account)
echo 2. Click "New +" button
echo 3. Select "Blueprint"
echo 4. Connect your GitHub account
echo 5. Select repository: romanian-energy-dashboard
echo 6. Click "Apply"
echo.
echo 🌐 Your dashboard will be available at:
echo https://romanian-energy-dashboard.onrender.com
echo.
echo ⏱️ Deployment takes 5-10 minutes
echo 📊 Data collection starts automatically
echo.

start https://render.com

echo.
echo ========================================
echo Deployment setup complete!
echo ========================================
echo.
echo Your dashboard features:
echo - Real-time Romanian energy data
echo - Auto-refresh every 10 seconds
echo - Power generation monitoring
echo - Imbalance price tracking
echo - 96 daily intervals
echo.
echo Press any key to exit...
pause >nul
