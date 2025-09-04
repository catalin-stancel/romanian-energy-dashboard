"""
Simplified FastAPI web application for Romanian Energy Balancing Market dashboard.
This version focuses on basic functionality to ensure successful deployment.
"""

from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from datetime import datetime
from pathlib import Path
import logging
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Romanian Energy Balancing Market Dashboard",
    description="Real-time monitoring for Romanian energy balancing market",
    version="1.0.0"
)

# Setup templates
templates_dir = Path(__file__).parent / "templates"
templates_dir.mkdir(exist_ok=True)
templates = Jinja2Templates(directory=str(templates_dir))

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard page."""
    return templates.TemplateResponse("dashboard.html", {"request": request})

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.0",
        "environment": os.getenv("RENDER", "development")
    }

@app.get("/api/status")
async def get_status():
    """Get application status."""
    return {
        "status": "running",
        "message": "Romanian Energy Dashboard is operational",
        "timestamp": datetime.now().isoformat()
    }

# Create a simple dashboard template
def create_simple_dashboard():
    """Create a simple dashboard HTML template."""
    template_content = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Romanian Energy Balancing Market Dashboard</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            text-align: center;
        }
        .header {
            background: rgba(255, 255, 255, 0.1);
            padding: 40px;
            border-radius: 20px;
            margin-bottom: 40px;
            backdrop-filter: blur(10px);
        }
        .status-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 30px;
            border-radius: 15px;
            margin: 20px 0;
            backdrop-filter: blur(10px);
        }
        .success {
            background: rgba(40, 167, 69, 0.2);
            border: 2px solid #28a745;
        }
        .btn {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 2px solid white;
            padding: 15px 30px;
            border-radius: 10px;
            cursor: pointer;
            margin: 10px;
            font-size: 16px;
            transition: all 0.3s ease;
        }
        .btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
        .feature-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 40px;
        }
        .feature-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 25px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }
        .emoji {
            font-size: 3em;
            margin-bottom: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🇷🇴 Romanian Energy Balancing Market Dashboard</h1>
            <p>Real-time monitoring and analysis platform</p>
        </div>

        <div class="status-card success">
            <h2>✅ Deployment Successful!</h2>
            <p>Your Romanian Energy Dashboard is now live and running on Render.com</p>
            <p id="timestamp">Loading...</p>
        </div>

        <div class="status-card">
            <h3>🚀 Application Status</h3>
            <button class="btn" onclick="checkHealth()">Check Health</button>
            <button class="btn" onclick="checkAPI()">Test API</button>
            <div id="status-result" style="margin-top: 20px;"></div>
        </div>

        <div class="feature-grid">
            <div class="feature-card">
                <div class="emoji">⚡</div>
                <h3>Real-time Data</h3>
                <p>Monitor Romanian energy balancing market data in real-time</p>
            </div>
            
            <div class="feature-card">
                <div class="emoji">📊</div>
                <h3>Power Generation</h3>
                <p>Track power generation by source (hydro, wind, solar, thermal)</p>
            </div>
            
            <div class="feature-card">
                <div class="emoji">🔄</div>
                <h3>Import/Export</h3>
                <p>Monitor import/export flows with neighboring countries</p>
            </div>
            
            <div class="feature-card">
                <div class="emoji">💰</div>
                <h3>Market Prices</h3>
                <p>Analyze market prices and balancing costs</p>
            </div>
            
            <div class="feature-card">
                <div class="emoji">📈</div>
                <h3>Trends</h3>
                <p>View historical trends and analysis</p>
            </div>
            
            <div class="feature-card">
                <div class="emoji">🔮</div>
                <h3>Forecasting</h3>
                <p>Price prediction and market forecasting</p>
            </div>
        </div>
    </div>

    <script>
        // Update timestamp
        document.getElementById('timestamp').textContent = 
            'Last updated: ' + new Date().toLocaleString();

        // Health check function
        async function checkHealth() {
            const resultDiv = document.getElementById('status-result');
            resultDiv.innerHTML = 'Checking health...';
            
            try {
                const response = await fetch('/health');
                const data = await response.json();
                
                resultDiv.innerHTML = `
                    <div style="color: #28a745; margin-top: 15px;">
                        <strong>✅ Health Check Passed</strong><br>
                        Status: ${data.status}<br>
                        Environment: ${data.environment}<br>
                        Version: ${data.version}
                    </div>
                `;
            } catch (error) {
                resultDiv.innerHTML = `
                    <div style="color: #dc3545; margin-top: 15px;">
                        <strong>❌ Health Check Failed</strong><br>
                        Error: ${error.message}
                    </div>
                `;
            }
        }

        // API test function
        async function checkAPI() {
            const resultDiv = document.getElementById('status-result');
            resultDiv.innerHTML = 'Testing API...';
            
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                resultDiv.innerHTML = `
                    <div style="color: #28a745; margin-top: 15px;">
                        <strong>✅ API Test Passed</strong><br>
                        Status: ${data.status}<br>
                        Message: ${data.message}
                    </div>
                `;
            } catch (error) {
                resultDiv.innerHTML = `
                    <div style="color: #dc3545; margin-top: 15px;">
                        <strong>❌ API Test Failed</strong><br>
                        Error: ${error.message}
                    </div>
                `;
            }
        }

        // Auto-update timestamp every 30 seconds
        setInterval(() => {
            document.getElementById('timestamp').textContent = 
                'Last updated: ' + new Date().toLocaleString();
        }, 30000);
    </script>
</body>
</html>
    """
    
    template_path = templates_dir / "dashboard.html"
    with open(template_path, 'w', encoding='utf-8') as f:
        f.write(template_content)
    
    logger.info(f"Created simple dashboard template at {template_path}")

# Create the template on startup
create_simple_dashboard()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
