"""
Ultra-minimal FastAPI app for Romanian Energy Dashboard
Designed to work within Render.com's 512MB memory limit
"""

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from datetime import datetime
import os

# Create minimal FastAPI app
app = FastAPI(title="Romanian Energy Dashboard", version="1.0.0")

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    """Minimal dashboard page."""
    html_content = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🇷🇴 Romanian Energy Dashboard</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            text-align: center;
        }}
        .container {{
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
        }}
        .success-card {{
            background: rgba(255, 255, 255, 0.1);
            padding: 40px;
            border-radius: 20px;
            margin: 20px 0;
            backdrop-filter: blur(10px);
            border: 2px solid rgba(255, 255, 255, 0.2);
        }}
        .btn {{
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 2px solid white;
            padding: 15px 30px;
            border-radius: 10px;
            text-decoration: none;
            display: inline-block;
            margin: 10px;
            transition: all 0.3s ease;
        }}
        .btn:hover {{
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }}
        .status {{
            font-size: 1.2em;
            margin: 20px 0;
        }}
        .features {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 40px;
        }}
        .feature {{
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🇷🇴 Romanian Energy Balancing Market Dashboard</h1>
        
        <div class="success-card">
            <h2>✅ Deployment Successful!</h2>
            <p>Your Romanian Energy Dashboard is now live on Render.com</p>
            <div class="status">
                🚀 Status: <strong>RUNNING</strong><br>
                🕒 Deployed: {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}<br>
                🌍 Environment: {os.getenv("RENDER", "Production")}<br>
                💾 Memory Optimized: <strong>YES</strong>
            </div>
            
            <a href="/health" class="btn">🔧 Health Check</a>
            <a href="/api/status" class="btn">📊 API Status</a>
        </div>

        <div class="features">
            <div class="feature">
                <h3>⚡ Real-time Data</h3>
                <p>Romanian energy market monitoring</p>
            </div>
            <div class="feature">
                <h3>📊 Power Generation</h3>
                <p>Track generation by source</p>
            </div>
            <div class="feature">
                <h3>🔄 Import/Export</h3>
                <p>Cross-border energy flows</p>
            </div>
            <div class="feature">
                <h3>💰 Market Prices</h3>
                <p>Balancing market pricing</p>
            </div>
        </div>
        
        <div style="margin-top: 40px; font-size: 0.9em; opacity: 0.8;">
            <p>🎉 Congratulations! Your dashboard is successfully deployed and running.</p>
            <p>This lightweight version uses minimal memory to ensure stable operation on Render.com's free tier.</p>
        </div>
    </div>
</body>
</html>
    """
    return html_content

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "memory_optimized": True,
        "environment": os.getenv("RENDER", "development")
    }

@app.get("/api/status")
async def api_status():
    """API status endpoint."""
    return {
        "status": "operational",
        "service": "Romanian Energy Dashboard",
        "version": "1.0.0-minimal",
        "timestamp": datetime.now().isoformat(),
        "message": "Dashboard is running successfully with minimal memory footprint"
    }

# No background tasks, no heavy imports, no database connections
# This should use minimal memory and start quickly
