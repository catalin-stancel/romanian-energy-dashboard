"""
Memory-optimized FastAPI app for Romanian Energy Dashboard
Keeps essential functionality while staying within 512MB memory limit
"""

from fastapi import FastAPI, Request, HTTPException
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from datetime import datetime, timedelta
from pathlib import Path
import logging
import os
import sys

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

# Import only essential modules (no pandas, numpy, scikit-learn, etc.)
from src.data.models import (
    ImbalancePrice, ImbalanceVolume, NetImbalanceVolume, 
    PowerGenerationData, get_session
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Romanian Energy Balancing Market Dashboard",
    description="Memory-optimized real-time monitoring for Romanian energy balancing market",
    version="1.0.0-optimized"
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
        "version": "1.0.0-optimized",
        "memory_optimized": True,
        "environment": os.getenv("RENDER", "development")
    }

@app.get("/api/status")
async def get_status():
    """Get application status with database connection test."""
    try:
        # Test database connection
        with get_session() as session:
            price_count = session.query(ImbalancePrice).count()
            volume_count = session.query(ImbalanceVolume).count()
            power_count = session.query(PowerGenerationData).count()
        
        return {
            "status": "operational",
            "service": "Romanian Energy Dashboard",
            "version": "1.0.0-optimized",
            "timestamp": datetime.now().isoformat(),
            "database": {
                "connected": True,
                "price_records": price_count,
                "volume_records": volume_count,
                "power_records": power_count
            },
            "message": "Dashboard is running with database connectivity"
        }
    except Exception as e:
        logger.error(f"Database connection failed: {str(e)}")
        return {
            "status": "degraded",
            "service": "Romanian Energy Dashboard",
            "version": "1.0.0-optimized",
            "timestamp": datetime.now().isoformat(),
            "database": {
                "connected": False,
                "error": str(e)
            },
            "message": "Dashboard is running but database connection failed"
        }

@app.get("/api/recent-data")
async def get_recent_data(hours: int = 24):
    """Get recent market data (lightweight version without pandas)."""
    try:
        end_date = datetime.now()
        start_date = end_date - timedelta(hours=hours)
        
        with get_session() as session:
            # Get recent price data
            price_records = session.query(ImbalancePrice).filter(
                ImbalancePrice.timestamp >= start_date,
                ImbalancePrice.timestamp <= end_date
            ).order_by(ImbalancePrice.timestamp.desc()).limit(100).all()
            
            # Get recent volume data
            volume_records = session.query(NetImbalanceVolume).filter(
                NetImbalanceVolume.timestamp >= start_date,
                NetImbalanceVolume.timestamp <= end_date
            ).order_by(NetImbalanceVolume.timestamp.desc()).limit(100).all()
            
            # Get recent power data
            power_records = session.query(PowerGenerationData).filter(
                PowerGenerationData.timestamp >= start_date,
                PowerGenerationData.timestamp <= end_date
            ).order_by(PowerGenerationData.timestamp.desc()).limit(100).all()
            
            # Format data using basic Python (no pandas)
            prices = [
                {
                    "timestamp": record.timestamp.isoformat(),
                    "value": float(record.value),
                    "category": record.price_category
                }
                for record in price_records
            ]
            
            volumes = [
                {
                    "timestamp": record.timestamp.isoformat(),
                    "net_volume": float(record.net_volume),
                    "status": record.status,
                    "import_volume": float(record.import_volume),
                    "export_volume": float(record.export_volume)
                }
                for record in volume_records
            ]
            
            power_data = [
                {
                    "timestamp": record.timestamp.isoformat(),
                    "production": float(record.total_production),
                    "consumption": float(record.total_consumption),
                    "net_balance": float(record.net_balance),
                    "nuclear": float(record.nuclear or 0),
                    "hydro": float(record.hydro or 0),
                    "wind": float(record.wind or 0),
                    "solar": float(record.solar or 0)
                }
                for record in power_records
            ]
            
            return {
                "prices": prices,
                "volumes": volumes,
                "power_generation": power_data,
                "data_range": {
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat(),
                    "hours": hours
                },
                "record_counts": {
                    "prices": len(prices),
                    "volumes": len(volumes),
                    "power": len(power_data)
                }
            }
            
    except Exception as e:
        logger.error(f"Error fetching recent data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch recent data: {str(e)}")

@app.get("/api/current-status")
async def get_current_status():
    """Get current market status (lightweight calculations)."""
    try:
        with get_session() as session:
            # Get latest records
            latest_price = session.query(ImbalancePrice)\
                .order_by(ImbalancePrice.timestamp.desc()).first()
            
            latest_volume = session.query(NetImbalanceVolume)\
                .order_by(NetImbalanceVolume.timestamp.desc()).first()
            
            latest_power = session.query(PowerGenerationData)\
                .order_by(PowerGenerationData.timestamp.desc()).first()
            
            # Calculate simple statistics using basic Python
            current_status = {
                "timestamp": datetime.now().isoformat(),
                "latest_data": {}
            }
            
            if latest_price:
                current_status["latest_data"]["price"] = {
                    "value": float(latest_price.value),
                    "category": latest_price.price_category,
                    "timestamp": latest_price.timestamp.isoformat()
                }
            
            if latest_volume:
                current_status["latest_data"]["volume"] = {
                    "net_volume": float(latest_volume.net_volume),
                    "status": latest_volume.status,
                    "timestamp": latest_volume.timestamp.isoformat()
                }
            
            if latest_power:
                current_status["latest_data"]["power"] = {
                    "production": float(latest_power.total_production),
                    "consumption": float(latest_power.total_consumption),
                    "net_balance": float(latest_power.net_balance),
                    "timestamp": latest_power.timestamp.isoformat()
                }
            
            return current_status
            
    except Exception as e:
        logger.error(f"Error getting current status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get current status: {str(e)}")

# Create optimized dashboard template
def create_optimized_dashboard():
    """Create dashboard template with JavaScript charts (no server-side plotting)."""
    template_content = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🇷🇴 Romanian Energy Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
        }
        .header {
            text-align: center;
            background: rgba(255, 255, 255, 0.1);
            padding: 30px;
            border-radius: 15px;
            margin-bottom: 30px;
            backdrop-filter: blur(10px);
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .status-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            text-align: center;
        }
        .chart-container {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
            backdrop-filter: blur(10px);
        }
        .btn {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 2px solid white;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            margin: 5px;
            transition: all 0.3s ease;
        }
        .btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        .success { color: #28a745; }
        .warning { color: #ffc107; }
        .error { color: #dc3545; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🇷🇴 Romanian Energy Balancing Market Dashboard</h1>
        <p>Memory-Optimized Real-time Monitoring</p>
        <button class="btn" onclick="refreshData()">🔄 Refresh Data</button>
        <button class="btn" onclick="checkStatus()">📊 Check Status</button>
    </div>

    <div class="status-grid">
        <div class="status-card">
            <h3>💾 Memory Status</h3>
            <p class="success">✅ Optimized</p>
            <p>Using <512MB RAM</p>
        </div>
        <div class="status-card">
            <h3>🗄️ Database</h3>
            <p id="db-status">Checking...</p>
        </div>
        <div class="status-card">
            <h3>📊 Latest Data</h3>
            <p id="data-status">Loading...</p>
        </div>
        <div class="status-card">
            <h3>🕒 Last Update</h3>
            <p id="last-update">-</p>
        </div>
    </div>

    <div class="chart-container">
        <h3>📈 Recent Price Data</h3>
        <canvas id="priceChart" width="400" height="200"></canvas>
    </div>

    <div class="chart-container">
        <h3>⚡ Power Generation</h3>
        <canvas id="powerChart" width="400" height="200"></canvas>
    </div>

    <script>
        let priceChart, powerChart;

        // Initialize charts
        function initCharts() {
            const priceCtx = document.getElementById('priceChart').getContext('2d');
            priceChart = new Chart(priceCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Price (EUR/MWh)',
                        data: [],
                        borderColor: '#28a745',
                        backgroundColor: 'rgba(40, 167, 69, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    scales: { y: { beginAtZero: true } }
                }
            });

            const powerCtx = document.getElementById('powerChart').getContext('2d');
            powerChart = new Chart(powerCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Production (MW)',
                            data: [],
                            borderColor: '#007bff',
                            backgroundColor: 'rgba(0, 123, 255, 0.1)',
                            tension: 0.4
                        },
                        {
                            label: 'Consumption (MW)',
                            data: [],
                            borderColor: '#dc3545',
                            backgroundColor: 'rgba(220, 53, 69, 0.1)',
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    scales: { y: { beginAtZero: true } }
                }
            });
        }

        // Check status
        async function checkStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                document.getElementById('db-status').innerHTML = 
                    data.database.connected ? 
                    '<span class="success">✅ Connected</span>' : 
                    '<span class="error">❌ Disconnected</span>';
                
                if (data.database.connected) {
                    document.getElementById('data-status').innerHTML = 
                        `<span class="success">📊 ${data.database.price_records} prices<br>
                        📈 ${data.database.volume_records} volumes<br>
                        ⚡ ${data.database.power_records} power</span>`;
                }
            } catch (error) {
                document.getElementById('db-status').innerHTML = 
                    '<span class="error">❌ Error</span>';
            }
        }

        // Refresh data
        async function refreshData() {
            try {
                const response = await fetch('/api/recent-data?hours=24');
                const data = await response.json();
                
                // Update price chart
                if (data.prices.length > 0) {
                    const labels = data.prices.slice(-20).map(p => 
                        new Date(p.timestamp).toLocaleTimeString());
                    const values = data.prices.slice(-20).map(p => p.value);
                    
                    priceChart.data.labels = labels;
                    priceChart.data.datasets[0].data = values;
                    priceChart.update();
                }
                
                // Update power chart
                if (data.power_generation.length > 0) {
                    const labels = data.power_generation.slice(-20).map(p => 
                        new Date(p.timestamp).toLocaleTimeString());
                    const production = data.power_generation.slice(-20).map(p => p.production);
                    const consumption = data.power_generation.slice(-20).map(p => p.consumption);
                    
                    powerChart.data.labels = labels;
                    powerChart.data.datasets[0].data = production;
                    powerChart.data.datasets[1].data = consumption;
                    powerChart.update();
                }
                
                document.getElementById('last-update').textContent = 
                    new Date().toLocaleTimeString();
                    
            } catch (error) {
                console.error('Error refreshing data:', error);
            }
        }

        // Initialize on load
        document.addEventListener('DOMContentLoaded', function() {
            initCharts();
            checkStatus();
            refreshData();
            
            // Auto-refresh every 30 seconds
            setInterval(refreshData, 30000);
        });
    </script>
</body>
</html>
    """
    
    template_path = templates_dir / "dashboard.html"
    with open(template_path, 'w', encoding='utf-8') as f:
        f.write(template_content)
    
    logger.info(f"Created optimized dashboard template at {template_path}")

# Create the template on startup
create_optimized_dashboard()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
