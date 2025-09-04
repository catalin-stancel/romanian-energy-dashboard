"""
FastAPI web application for Romanian Energy Balancing Market dashboard.
Provides real-time data visualization and price forecasting interface.
"""

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
import json
import logging
import asyncio
from pathlib import Path
import pytz
import threading
import time

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.data.models import (
    ImbalancePrice, ImbalanceVolume, NetImbalanceVolume, DataCollectionLog, 
    MarketStatistics, PriceForecast, PowerGenerationData, get_session
)
from src.data.enhanced_collector import EnhancedDataCollector
from src.data.collector import DataCollector
from src.data.interval_transition_collector import IntervalTransitionCollector
from src.analysis.price_estimator import PriceEstimator
from src.api.entsoe_client import ENTSOEClient

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Romanian timezone
ROMANIAN_TZ = pytz.timezone('Europe/Bucharest')

def get_romanian_time():
    """Get current time in Romanian timezone."""
    return datetime.now(ROMANIAN_TZ)

def to_romanian_time(dt):
    """Convert datetime to Romanian timezone."""
    if dt.tzinfo is None:
        # Assume UTC if no timezone info
        dt = pytz.UTC.localize(dt)
    return dt.astimezone(ROMANIAN_TZ)

# Initialize FastAPI app
app = FastAPI(
    title="Romanian Energy Balancing Market Dashboard",
    description="Real-time monitoring and price forecasting for Romanian energy balancing market",
    version="1.0.0"
)

@app.on_event("startup")
async def startup_event():
    """Start background data collection when the app starts."""
    start_background_collection()
    logger.info("🚀 FastAPI app started with background data collection")

@app.on_event("shutdown")
async def shutdown_event():
    """Stop background data collection when the app shuts down."""
    stop_background_collection()
    logger.info("🛑 FastAPI app shutdown, background collection stopped")

# Setup templates and static files
templates_dir = Path(__file__).parent / "templates"
static_dir = Path(__file__).parent / "static"

templates_dir.mkdir(exist_ok=True)
static_dir.mkdir(exist_ok=True)

templates = Jinja2Templates(directory=str(templates_dir))
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# Initialize components - Force reload by recreating instances
enhanced_collector = EnhancedDataCollector()
price_collector = DataCollector()
# Force fresh import of PowerGenerationCollector and TranselectricaClient
import importlib
import src.data.power_generation_collector
import src.api.transelectrica_client
importlib.reload(src.data.power_generation_collector)
importlib.reload(src.api.transelectrica_client)
power_collector = IntervalTransitionCollector()
estimator = PriceEstimator()
client = ENTSOEClient()

# Background data collection state
background_collection_active = False
last_collection_time = None


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard page."""
    return templates.TemplateResponse("dashboard.html", {"request": request})


@app.get("/api/market-data")
async def get_market_data(days_back: int = 7) -> Dict[str, Any]:
    """Get recent market data for visualization."""
    try:
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)
        
        with get_session() as session:
            # Get price data
            price_data = session.query(ImbalancePrice).filter(
                ImbalancePrice.timestamp >= start_date,
                ImbalancePrice.timestamp <= end_date
            ).order_by(ImbalancePrice.timestamp).all()
            
            # Get volume data
            volume_data = session.query(ImbalanceVolume).filter(
                ImbalanceVolume.timestamp >= start_date,
                ImbalanceVolume.timestamp <= end_date
            ).order_by(ImbalanceVolume.timestamp).all()
            
            # Format data for JSON response
            prices = [
                {
                    "timestamp": record.timestamp.isoformat(),
                    "value": record.value,
                    "category": record.price_category,
                    "unit": record.measure_unit
                }
                for record in price_data
            ]
            
            volumes = [
                {
                    "timestamp": record.timestamp.isoformat(),
                    "value": record.value,
                    "unit": record.measure_unit
                }
                for record in volume_data
            ]
            
            return {
                "prices": prices,
                "volumes": volumes,
                "data_range": {
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat()
                }
            }
            
    except Exception as e:
        logger.error(f"Error fetching market data: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch market data")


@app.get("/api/statistics")
async def get_market_statistics() -> Dict[str, Any]:
    """Get comprehensive market statistics."""
    try:
        stats = estimator.calculate_market_statistics(days_back=30)
        
        # Add collection statistics
        with get_session() as session:
            total_prices = session.query(ImbalancePrice).count()
            total_volumes = session.query(ImbalanceVolume).count()
            
            recent_collections = session.query(DataCollectionLog)\
                .order_by(DataCollectionLog.collection_time.desc())\
                .limit(5).all()
            
            collection_stats = [
                {
                    "type": log.collection_type,
                    "records": log.records_collected,
                    "success": log.success,
                    "timestamp": log.collection_time.isoformat(),
                    "error": log.error_message
                }
                for log in recent_collections
            ]
        
        stats.update({
            "total_records": {
                "prices": total_prices,
                "volumes": total_volumes
            },
            "recent_collections": collection_stats
        })
        
        return stats
        
    except Exception as e:
        logger.error(f"Error calculating statistics: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to calculate statistics")


@app.get("/api/forecasts")
async def get_price_forecasts(hours: int = 24) -> Dict[str, Any]:
    """Get price forecasts."""
    try:
        # Load historical data and try to train models
        data = estimator.load_historical_data(days_back=30)
        
        if data.empty:
            return {"forecasts": [], "message": "No historical data available"}
        
        # Check if we have price data for training
        if 'value_price' not in data.columns or data['value_price'].isna().all():
            return {"forecasts": [], "message": "No price data available for forecasting"}
        
        # Create features and train models
        feature_data = estimator.create_features(data)
        performance = estimator.train_models(feature_data)
        
        if not performance:
            return {"forecasts": [], "message": "Insufficient data for model training"}
        
        # Generate forecasts
        forecasts = estimator.predict_prices(forecast_hours=hours)
        
        if forecasts.empty:
            return {"forecasts": [], "message": "Failed to generate forecasts"}
        
        # Format forecasts for JSON response
        forecast_data = [
            {
                "timestamp": row['timestamp'].isoformat(),
                "predicted_price": row['predicted_price'],
                "model": row['model']
            }
            for _, row in forecasts.iterrows()
        ]
        
        return {
            "forecasts": forecast_data,
            "model_performance": performance,
            "message": f"Generated {len(forecast_data)} forecasts"
        }
        
    except Exception as e:
        logger.error(f"Error generating forecasts: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to generate forecasts")


@app.post("/api/collect-data")
async def trigger_data_collection(background_tasks: BackgroundTasks, days_back: int = 1):
    """Trigger data collection in the background."""
    try:
        background_tasks.add_task(collect_data_background, days_back)
        return {"message": f"Data collection started for last {days_back} days"}
        
    except Exception as e:
        logger.error(f"Error triggering data collection: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to trigger data collection")


async def collect_data_background(days_back: int):
    """Background task for data collection."""
    try:
        logger.info(f"Starting background data collection for last {days_back} days")
        success = price_collector.collect_recent_data(days_back=days_back)
        
        if success:
            logger.info("Background data collection completed successfully")
        else:
            logger.warning("Background data collection completed with issues")
            
    except Exception as e:
        logger.error(f"Background data collection failed: {str(e)}")


@app.get("/api/daily-intervals")
async def get_daily_intervals(target_date: Optional[str] = None) -> Dict[str, Any]:
    """Get daily interval data (96 intervals per day) for actual data table."""
    try:
        # Parse target date or prioritize current day data
        if target_date:
            date = datetime.fromisoformat(target_date.replace('Z', '+00:00'))
        else:
            # Prioritize showing today's data if available, otherwise show most recent
            today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            tomorrow = today + timedelta(days=1)
            
            with get_session() as session:
                # Check if we have any data for today
                today_price_count = session.query(ImbalancePrice).filter(
                    ImbalancePrice.timestamp >= today,
                    ImbalancePrice.timestamp < tomorrow
                ).count()
                
                today_volume_count = session.query(ImbalanceVolume).filter(
                    ImbalanceVolume.timestamp >= today,
                    ImbalanceVolume.timestamp < tomorrow
                ).count()
                
                # If we have data for today, show today
                if today_price_count > 0 or today_volume_count > 0:
                    date = today
                else:
                    # Otherwise, find the most recent date with actual data
                    latest_volume = session.query(ImbalanceVolume.timestamp)\
                        .order_by(ImbalanceVolume.timestamp.desc()).first()
                    latest_price = session.query(ImbalancePrice.timestamp)\
                        .order_by(ImbalancePrice.timestamp.desc()).first()
                    
                    if latest_volume or latest_price:
                        # Use the most recent date from either volume or price data
                        latest_date = None
                        if latest_volume and latest_price:
                            latest_date = max(latest_volume[0], latest_price[0])
                        elif latest_volume:
                            latest_date = latest_volume[0]
                        elif latest_price:
                            latest_date = latest_price[0]
                        
                        if latest_date:
                            date = latest_date
                        else:
                            date = today
                    else:
                        date = today
        
        # Get start and end of the day
        start_date = date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        with get_session() as session:
            # Get price and enhanced volume data for the day
            price_data = session.query(ImbalancePrice).filter(
                ImbalancePrice.timestamp >= start_date,
                ImbalancePrice.timestamp < end_date
            ).order_by(ImbalancePrice.timestamp).all()
            
            # Try to get enhanced volume data first, fallback to old volume data
            enhanced_volume_data = session.query(NetImbalanceVolume).filter(
                NetImbalanceVolume.timestamp >= start_date,
                NetImbalanceVolume.timestamp < end_date
            ).order_by(NetImbalanceVolume.timestamp).all()
            
            # Fallback to old volume data if no enhanced data available
            if not enhanced_volume_data:
                volume_data = session.query(ImbalanceVolume).filter(
                    ImbalanceVolume.timestamp >= start_date,
                    ImbalanceVolume.timestamp < end_date
                ).order_by(ImbalanceVolume.timestamp).all()
            else:
                volume_data = []  # We'll use enhanced_volume_data instead
            
            # Create 96 intervals for the day
            all_intervals = []
            current_time = get_romanian_time()
            
            for i in range(96):  # 96 intervals of 15 minutes each
                interval_start = start_date + timedelta(minutes=i * 15)
                interval_end = interval_start + timedelta(minutes=15)
                
                # Find matching price and volume data
                # For prices, prefer A04 category if available, otherwise use A05
                price_record = next((p for p in price_data if p.timestamp == interval_start and p.price_category == 'A04'), None)
                if not price_record:
                    price_record = next((p for p in price_data if p.timestamp == interval_start and p.price_category == 'A05'), None)
                
                # Use enhanced volume data if available, otherwise fallback to old volume data
                enhanced_volume_record = None
                volume_record = None
                surplus_deficit = None
                volume_value = None
                
                if enhanced_volume_data:
                    enhanced_volume_record = next((v for v in enhanced_volume_data if v.timestamp == interval_start), None)
                    if enhanced_volume_record:
                        volume_value = enhanced_volume_record.net_volume
                        surplus_deficit = enhanced_volume_record.status
                else:
                    volume_record = next((v for v in volume_data if v.timestamp == interval_start), None)
                    if volume_record:
                        volume_value = volume_record.value
                        surplus_deficit = "Surplus" if volume_record.value > 0 else "Deficit" if volume_record.value < 0 else "Balanced"
                
                # Convert times for comparison (database times are timezone-naive)
                current_time_naive = current_time.replace(tzinfo=None)
                
                # Determine if this interval is current, past, or future
                is_current = interval_start <= current_time_naive < interval_end
                is_delayed = current_time_naive - interval_start < timedelta(minutes=45)  # 3 intervals delay
                
                interval_data = {
                    "interval": i + 1,
                    "time": interval_start.strftime("%Y-%m-%d %H:%M"),
                    "timestamp": interval_start.isoformat(),
                    "price": price_record.value if price_record else None,
                    "volume": volume_value,
                    "surplus_deficit": surplus_deficit,
                    "is_current": is_current,
                    "is_delayed": is_delayed,
                    "has_data": price_record is not None or (enhanced_volume_record is not None or volume_record is not None)
                }
                all_intervals.append(interval_data)
            
            # Always return all 96 intervals for the day
            current_interval_num = next((i["interval"] for i in all_intervals if i["is_current"]), None)
            
            return {
                "date": start_date.date().isoformat(),
                "intervals": all_intervals,
                "current_interval": current_interval_num,
                "total_intervals": len(all_intervals)
            }
            
    except Exception as e:
        logger.error(f"Error fetching daily intervals: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch daily intervals")


@app.get("/api/predicted-intervals")
async def get_predicted_intervals(target_date: Optional[str] = None) -> Dict[str, Any]:
    """Get predicted interval data for the prediction table."""
    try:
        # Parse target date or use current date
        if target_date:
            date = datetime.fromisoformat(target_date.replace('Z', '+00:00'))
        else:
            date = datetime.now()
        
        # Get start of the day
        start_date = date.replace(hour=0, minute=0, second=0, microsecond=0)
        current_time = get_romanian_time()
        
        # Load historical data for prediction
        historical_data = estimator.load_historical_data(days_back=30)
        
        intervals = []
        
        for i in range(96):  # 96 intervals of 15 minutes each
            interval_start = start_date + timedelta(minutes=i * 15)
            interval_end = interval_start + timedelta(minutes=15)
            
            # Convert times for comparison (database times are timezone-naive)
            current_time_naive = current_time.replace(tzinfo=None)
            
            # Determine if this is current or next interval (our prediction targets)
            is_current = interval_start <= current_time_naive < interval_end
            is_next = interval_start <= current_time_naive + timedelta(minutes=15) < interval_end
            is_prediction_target = is_current or is_next
            
            # Generate prediction for this interval
            predicted_price = None
            predicted_volume = None
            confidence = None
            
            if not historical_data.empty and is_prediction_target:
                try:
                    # Create features for this specific interval
                    feature_data = estimator.create_features(historical_data)
                    if not feature_data.empty:
                        # Train models if not already trained
                        performance = estimator.train_models(feature_data)
                        if performance:
                            # Generate prediction for this specific timestamp
                            forecast = estimator.predict_prices(forecast_hours=1)
                            if not forecast.empty:
                                predicted_price = forecast.iloc[0]['predicted_price']
                                confidence = 0.85  # Placeholder confidence
                                
                                # Estimate volume based on historical patterns
                                if 'value_volume' in historical_data.columns:
                                    recent_volumes = historical_data['value_volume'].dropna().tail(10)
                                    if not recent_volumes.empty:
                                        predicted_volume = recent_volumes.mean()
                except Exception as pred_error:
                    logger.warning(f"Prediction failed for interval {i}: {str(pred_error)}")
            
            # Calculate predicted surplus/deficit
            surplus_deficit = None
            if predicted_volume is not None:
                surplus_deficit = "Surplus" if predicted_volume > 0 else "Deficit" if predicted_volume < 0 else "Balanced"
            
            interval_data = {
                "interval": i + 1,
                "time": interval_start.strftime("%Y-%m-%d %H:%M"),
                "timestamp": interval_start.isoformat(),
                "predicted_price": predicted_price,
                "predicted_volume": predicted_volume,
                "surplus_deficit": surplus_deficit,
                "confidence": confidence,
                "is_current": is_current,
                "is_next": is_next,
                "is_prediction_target": is_prediction_target
            }
            intervals.append(interval_data)
        
        return {
            "date": start_date.date().isoformat(),
            "intervals": intervals,
            "current_interval": next((i["interval"] for i in intervals if i["is_current"]), None),
            "next_interval": next((i["interval"] for i in intervals if i["is_next"]), None),
            "total_intervals": 96
        }
        
    except Exception as e:
        logger.error(f"Error generating predicted intervals: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to generate predicted intervals")


@app.get("/api/power-generation")
async def get_power_generation_data() -> Dict[str, Any]:
    """Get current power generation data from Transelectrica including import/export units."""
    try:
        # Get latest power generation data
        latest_data = power_collector.get_latest_data()
        
        if not latest_data:
            return {
                "data": None,
                "message": "No power generation data available"
            }
        
        # Get generation mix percentages
        generation_mix = power_collector.get_generation_mix_percentage()
        
        # Get import/export units data from the API client directly
        api_data = power_collector.client.fetch_power_data()
        import_export_units = None
        total_import_export_units = 0
        
        if api_data and 'import_export_units' in api_data:
            import_export_units = api_data['import_export_units']
            total_import_export_units = api_data['total_import_export_units']
        
        return {
            "data": latest_data,
            "generation_mix": generation_mix,
            "import_export_units": import_export_units,
            "total_import_export_units": total_import_export_units,
            "message": "Power generation data retrieved successfully"
        }
        
    except Exception as e:
        logger.error(f"Error fetching power generation data: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch power generation data")


@app.post("/api/collect-power-data")
async def trigger_power_data_collection(background_tasks: BackgroundTasks):
    """Trigger power generation data collection in the background."""
    try:
        background_tasks.add_task(collect_power_data_background)
        return {"message": "Power generation data collection started"}
        
    except Exception as e:
        logger.error(f"Error triggering power data collection: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to trigger power data collection")


async def collect_power_data_background():
    """Background task for power generation data collection."""
    try:
        logger.info("Starting background power generation data collection")
        success = power_collector.collect_with_transition_handling(force_update=True)
        
        if success:
            logger.info("Background power generation data collection completed successfully")
        else:
            logger.warning("Background power generation data collection completed with issues")
            
    except Exception as e:
        logger.error(f"Background power generation data collection failed: {str(e)}")


@app.get("/api/connection-test")
async def test_api_connection():
    """Test ENTSO-E API connection."""
    try:
        success = client.test_connection()
        return {
            "connected": success,
            "message": "API connection successful" if success else "API connection failed"
        }
        
    except Exception as e:
        logger.error(f"Connection test failed: {str(e)}")
        return {
            "connected": False,
            "message": f"Connection test failed: {str(e)}"
        }


@app.get("/api/power-generation-intervals")
async def get_power_generation_intervals(target_date: Optional[str] = None) -> JSONResponse:
    """Get power generation data organized by 15-minute intervals with historical data."""
    try:
        # Force reload of TranselectricaClient to ensure we get the latest fixed code
        import importlib
        import src.api.transelectrica_client
        importlib.reload(src.api.transelectrica_client)
        
        # Create a fresh collector instance to ensure we get updated code
        from src.data.power_generation_collector import PowerGenerationCollector
        fresh_power_collector = PowerGenerationCollector()
        
        # Get latest data
        latest_power_data = fresh_power_collector.get_latest_data()
        
        if not latest_power_data:
            return {
                "date": datetime.now().date().isoformat(),
                "intervals": [],
                "current_interval": None,
                "total_intervals": 96,
                "historical_intervals": 0,
                "data_timestamp": None,
                "message": "No power generation data available"
            }
        
        # Get historical interval data for today
        current_time = datetime.now()
        start_date = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        # Get historical data from database
        historical_data = fresh_power_collector.get_interval_data(start_date, end_date)
        
        intervals = []
        current_interval_num = None
        historical_intervals = len(historical_data)
        
        for i in range(96):  # 96 intervals of 15 minutes each
            interval_start = start_date + timedelta(minutes=i * 15)
            interval_end = interval_start + timedelta(minutes=15)
            
            # Determine if this interval is current
            is_current = interval_start <= current_time < interval_end
            if is_current:
                current_interval_num = i + 1
            
            # Find historical data for this interval
            # historical_data is a dict with datetime keys, not a list
            historical_record = historical_data.get(interval_start)
            
            # For current interval, use fresh live API data
            if is_current:
                # For current interval, get fresh live API data
                live_api_data = fresh_power_collector.client.fetch_power_data()
                
                if live_api_data:
                    # Save the fresh live API data to database for historical preservation
                    try:
                        fresh_power_collector.collect_current_data(force_update=True)
                        logger.info(f"💾 Saved current interval data to database for historical preservation")
                    except Exception as save_error:
                        logger.warning(f"⚠️ Failed to save current interval data to database: {save_error}")
                    
                    # Use fresh live API data for current interval
                    production = live_api_data['totals']['production']
                    consumption = live_api_data['totals']['consumption']
                    imports = live_api_data['imports_total']
                    exports = live_api_data['exports_total']
                    interconnection_details = live_api_data.get('interconnections', {})
                elif latest_power_data:
                    # Fallback to latest data if live API fails
                    production = latest_power_data['totals']['production']
                    consumption = latest_power_data['totals']['consumption']
                    imports = latest_power_data.get('imports_total', latest_power_data['totals'].get('imports', 0.0))
                    exports = latest_power_data.get('exports_total', latest_power_data['totals'].get('exports', 0.0))
                    interconnection_details = latest_power_data.get('interconnections', {})
                else:
                    # No data available
                    production = None
                    consumption = None
                    imports = 0.0
                    exports = 0.0
                    interconnection_details = {}
                
                # Calculate net balance from production and consumption
                if production is not None and consumption is not None:
                    net_balance = production - consumption
                    # Determine status based on net balance
                    if net_balance > 0:
                        status = "Surplus"
                    elif net_balance < 0:
                        status = "Deficit"
                    else:
                        status = "Balanced"
                else:
                    net_balance = None
                    status = None
                
                has_data = True
                
            # For historical intervals, ONLY use database data
            elif historical_record:
                # Extract data from database record - historical_record is a dictionary from get_interval_data()
                production = historical_record['totals']['production']
                consumption = historical_record['totals']['consumption']
                net_balance = historical_record['totals']['net_balance']
                
                # Get imports and exports from database - need to query directly since get_interval_data doesn't include them
                session = get_session()
                try:
                    db_record = session.query(PowerGenerationData)\
                        .filter(PowerGenerationData.timestamp == interval_start)\
                        .order_by(PowerGenerationData.id.desc())\
                        .first()
                    
                    if db_record:
                        imports = db_record.imports or 0.0
                        exports = db_record.exports or 0.0
                    else:
                        imports = 0.0
                        exports = 0.0
                finally:
                    session.close()
                
                # Determine status based on net balance
                if net_balance > 0:
                    status = "Surplus"
                elif net_balance < 0:
                    status = "Deficit"
                else:
                    status = "Balanced"
                
                # Build interconnection details from database
                interconnection_details = historical_record['interconnections']
                
                has_data = True
                
            else:
                # No data available for this interval
                production = None
                consumption = None
                imports = 0.0
                exports = 0.0
                net_balance = None
                status = None
                has_data = False
                interconnection_details = {}
            
            # Extract only time portion
            time_only = interval_start.strftime("%H:%M")
            
            interval_data = {
                "interval": i + 1,
                "time": time_only,
                "timestamp": interval_start.isoformat(),
                "production": production,
                "consumption": consumption,
                "imports": imports,
                "exports": exports,
                "net_balance": net_balance,
                "status": status,
                "is_current": is_current,
                "has_data": has_data,
                "interconnection_details": interconnection_details
            }
            intervals.append(interval_data)
        
        # Always return all 96 intervals for the day
        response_data = {
            "date": start_date.date().isoformat(),
            "intervals": intervals,
            "current_interval": current_interval_num,
            "total_intervals": len(intervals),
            "historical_intervals": historical_intervals,
            "data_timestamp": latest_power_data['timestamp'].isoformat() if hasattr(latest_power_data['timestamp'], 'isoformat') else str(latest_power_data['timestamp'])
        }
        
        # Create response with cache-busting headers
        response = JSONResponse(content=response_data)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        response.headers["ETag"] = f'"{datetime.now().timestamp()}"'
        
        return response
        
    except Exception as e:
        logger.error(f"Error generating power generation intervals: {str(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to generate power generation intervals: {str(e)}")


@app.get("/api/transelectrica-connection-test")
async def test_transelectrica_connection():
    """Test Transelectrica API connection."""
    try:
        success = power_collector.test_connection()
        return {
            "connected": success,
            "message": "Transelectrica API connection successful" if success else "Transelectrica API connection failed"
        }
        
    except Exception as e:
        logger.error(f"Transelectrica connection test failed: {str(e)}")
        return {
            "connected": False,
            "message": f"Transelectrica connection test failed: {str(e)}"
        }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.1"  # Trigger reload
    }


@app.get("/api/debug-power-generation")
async def debug_power_generation():
    """Debug endpoint to test power generation data directly."""
    try:
        # Create a fresh collector instance
        from src.data.power_generation_collector import PowerGenerationCollector
        debug_collector = PowerGenerationCollector()
        
        # Test get_latest_data
        latest_data = debug_collector.get_latest_data()
        
        if not latest_data:
            return {"error": "No latest data available"}
        
        return {
            "status": "success",
            "latest_data": {
                "timestamp": latest_data['timestamp'].isoformat() if hasattr(latest_data['timestamp'], 'isoformat') else str(latest_data['timestamp']),
                "production": latest_data['totals']['production'],
                "consumption": latest_data['totals']['consumption'],
                "net_balance": latest_data['totals']['net_balance']
            },
            "message": "Debug endpoint working with fresh collector instance"
        }
        
    except Exception as e:
        logger.error(f"Debug endpoint error: {str(e)}")
        import traceback
        return {
            "error": str(e),
            "traceback": traceback.format_exc()
        }


def create_dashboard_template():
    """Create the main dashboard HTML template."""
    template_content = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Romanian Energy Balancing Market Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js"></script>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
        }
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .card {
            background: white;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .card h3 {
            margin-top: 0;
            color: #333;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            color: #667eea;
        }
        .stat-label {
            color: #666;
            margin-top: 5px;
        }
        .chart-container {
            position: relative;
            height: 400px;
            margin-top: 20px;
        }
        .controls {
            margin-bottom: 20px;
            text-align: center;
        }
        .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin: 0 5px;
        }
        .btn:hover {
            background: #5a6fd8;
        }
        .status {
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        .status.info {
            background: #d1ecf1;
            color: #0c5460;
            border: 1px solid #bee5eb;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🇷🇴 Romanian Energy Balancing Market Dashboard</h1>
        <p>Real-time monitoring and price forecasting</p>
    </div>

    <div class="controls">
        <button class="btn" onclick="refreshData()">🔄 Refresh Data</button>
        <button class="btn" onclick="collectData()">📥 Collect New Data</button>
        <button class="btn" onclick="testConnection()">🔗 Test API Connection</button>
    </div>

    <div id="status-messages"></div>

    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-value" id="total-volumes">-</div>
            <div class="stat-label">Volume Records</div>
        </div>
        <div class="stat-card">
            <div class="stat-value" id="total-prices">-</div>
            <div class="stat-label">Price Records</div>
        </div>
        <div class="stat-card">
            <div class="stat-value" id="avg-volume">-</div>
            <div class="stat-label">Avg Volume (MWh)</div>
        </div>
        <div class="stat-card">
            <div class="stat-value" id="connection-status">-</div>
            <div class="stat-label">API Status</div>
        </div>
    </div>

    <div class="dashboard-grid">
        <div class="card">
            <h3>📊 Volume Data</h3>
            <div class="chart-container">
                <canvas id="volumeChart"></canvas>
            </div>
        </div>

        <div class="card">
            <h3>💰 Price Data</h3>
            <div class="chart-container">
                <canvas id="priceChart"></canvas>
            </div>
        </div>

        <div class="card">
            <h3>🔮 Price Forecasts</h3>
            <div class="chart-container">
                <canvas id="forecastChart"></canvas>
            </div>
        </div>

        <div class="card">
            <h3>📈 Market Statistics</h3>
            <div id="market-stats" class="loading">Loading statistics...</div>
        </div>
    </div>

    <script>
        let volumeChart, priceChart, forecastChart;

        // Initialize charts
        function initCharts() {
            const volumeCtx = document.getElementById('volumeChart').getContext('2d');
            volumeChart = new Chart(volumeCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Volume (MWh)',
                        data: [],
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        }
                    }
                }
            });

            const priceCtx = document.getElementById('priceChart').getContext('2d');
            priceChart = new Chart(priceCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Price (EUR/MWh)',
                        data: [],
                        borderColor: '#764ba2',
                        backgroundColor: 'rgba(118, 75, 162, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        }
                    }
                }
            });

            const forecastCtx = document.getElementById('forecastChart').getContext('2d');
            forecastChart = new Chart(forecastCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Predicted Price (EUR/MWh)',
                        data: [],
                        borderColor: '#28a745',
                        backgroundColor: 'rgba(40, 167, 69, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true
                        }
                    }
                }
            });
        }

        // Show status message
        function showStatus(message, type = 'info') {
            const statusDiv = document.getElementById('status-messages');
            const statusElement = document.createElement('div');
            statusElement.className = `status ${type}`;
            statusElement.textContent = message;
            statusDiv.appendChild(statusElement);
            
            setTimeout(() => {
                statusElement.remove();
            }, 5000);
        }

        // Load market data
        async function loadMarketData() {
            try {
                const response = await axios.get('/api/market-data');
                const data = response.data;

                // Update volume chart
                if (data.volumes.length > 0) {
                    const volumeLabels = data.volumes.map(v => new Date(v.timestamp).toLocaleString());
                    const volumeValues = data.volumes.map(v => v.value);
                    
                    volumeChart.data.labels = volumeLabels;
                    volumeChart.data.datasets[0].data = volumeValues;
                    volumeChart.update();
                }

                // Update price chart
                if (data.prices.length > 0) {
                    const priceLabels = data.prices.map(p => new Date(p.timestamp).toLocaleString());
                    const priceValues = data.prices.map(p => p.value);
                    
                    priceChart.data.labels = priceLabels;
                    priceChart.data.datasets[0].data = priceValues;
                    priceChart.update();
                }

                showStatus(`Loaded ${data.volumes.length} volume records and ${data.prices.length} price records`, 'success');
            } catch (error) {
                console.error('Error loading market data:', error);
                showStatus('Failed to load market data', 'error');
            }
        }

        // Load statistics
        async function loadStatistics() {
            try {
                const response = await axios.get('/api/statistics');
                const stats = response.data;

                // Update stat cards
                document.getElementById('total-volumes').textContent = stats.total_records?.volumes || 0;
                document.getElementById('total-prices').textContent = stats.total_records?.prices || 0;
                
                if (stats.volume_stats) {
                    document.getElementById('avg-volume').textContent = stats.volume_stats.mean.toFixed(1);
                }

                // Update market stats display
                const statsDiv = document.getElementById('market-stats');
                let statsHtml = '';
                
                if (stats.volume_stats) {
                    statsHtml += `
                        <h4>Volume Statistics</h4>
                        <p>Mean: ${stats.volume_stats.mean.toFixed(2)} MWh</p>
                        <p>Range: ${stats.volume_stats.min.toFixed(2)} - ${stats.volume_stats.max.toFixed(2)} MWh</p>
                        <p>Records: ${stats.volume_stats.count}</p>
                    `;
                }
                
                if (stats.price_stats) {
                    statsHtml += `
                        <h4>Price Statistics</h4>
                        <p>Mean: ${stats.price_stats.mean.toFixed(2)} EUR/MWh</p>
                        <p>Range: ${stats.price_stats.min.toFixed(2)} - ${stats.price_stats.max.toFixed(2)} EUR/MWh</p>
                        <p>Records: ${stats.price_stats.count}</p>
                    `;
                }

                if (stats.recent_collections && stats.recent_collections.length > 0) {
                    statsHtml += '<h4>Recent Collections</h4>';
                    stats.recent_collections.forEach(collection => {
                        const status = collection.success ? '✅' : '❌';
                        statsHtml += `<p>${status} ${collection.type}: ${collection.records} records</p>`;
                    });
                }

                statsDiv.innerHTML = statsHtml || '<p>No statistics available</p>';
            } catch (error) {
                console.error('Error loading statistics:', error);
                document.getElementById('market-stats').innerHTML = '<p>Failed to load statistics</p>';
            }
        }

        // Load forecasts
        async function loadForecasts() {
            try {
                const response = await axios.get('/api/forecasts');
                const data = response.data;

                if (data.forecasts.length > 0) {
                    const forecastLabels = data.forecasts.map(f => new Date(f.timestamp).toLocaleString());
                    const forecastValues = data.forecasts.map(f => f.predicted_price);
                    
                    forecastChart.data.labels = forecastLabels;
                    forecastChart.data.datasets[0].data = forecastValues;
                    forecastChart.update();
                    
                    showStatus(`Generated ${data.forecasts.length} price forecasts`, 'success');
                } else {
                    showStatus(data.message || 'No forecasts available', 'info');
                }
            } catch (error) {
                console.error('Error loading forecasts:', error);
                showStatus('Failed to load forecasts', 'error');
            }
        }

        // Refresh all data
        async function refreshData() {
            showStatus('Refreshing data...', 'info');
            await Promise.all([
                loadMarketData(),
                loadStatistics(),
                loadForecasts()
            ]);
        }

        // Collect new data
        async function collectData() {
            try {
                showStatus('Starting data collection...', 'info');
                const response = await axios.post('/api/collect-data');
                showStatus(response.data.message, 'success');
                
                // Refresh data after a delay
                setTimeout(refreshData, 5000);
            } catch (error) {
                console.error('Error collecting data:', error);
                showStatus('Failed to start data collection', 'error');
            }
        }

        // Test API connection
        async function testConnection() {
            try {
                const response = await axios.get('/api/connection-test');
                const status = response.data.connected ? '🟢 Connected' : '🔴 Disconnected';
                document.getElementById('connection-status').textContent = status;
                showStatus(response.data.message, response.data.connected ? 'success' : 'error');
            } catch (error) {
                console.error('Error testing connection:', error);
                document.getElementById('connection-status').textContent = '🔴 Error';
                showStatus('Connection test failed', 'error');
            }
        }

        // Initialize dashboard
        document.addEventListener('DOMContentLoaded', function() {
            initCharts();
            refreshData();
            testConnection();
            
            // Auto-refresh every 10 seconds
            setInterval(refreshData, 10 * 1000);
        });
    </script>
</body>
</html>
    """
    
    template_path = templates_dir / "dashboard.html"
    with open(template_path, 'w', encoding='utf-8') as f:
        f.write(template_content)
    
    logger.info(f"Created dashboard template at {template_path}")


def background_data_collector():
    """Background thread for automatic data collection every 10 seconds."""
    global background_collection_active, last_collection_time
    
    logger.info("🤖 Background data collector started (10-second interval)")
    
    while background_collection_active:
        try:
            current_time = datetime.now()
            
            # Collect today's data with force_update to get latest
            today = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
            tomorrow = today + timedelta(days=1)
            
            logger.info("🔄 Background collection: Fetching latest data...")
            
            # Collect price data using the regular collector
            price_success = price_collector.collect_imbalance_prices(
                today, tomorrow, force_update=True
            )
            
            # Collect enhanced volume data using the enhanced collector
            volume_success = enhanced_collector.collect_enhanced_imbalance_volumes(
                today, tomorrow, force_update=True
            )
            
            # Collect power generation data using the interval transition collector
            power_success = power_collector.collect_with_transition_handling(force_update=True)
            
            # Determine overall success
            success_count = sum([price_success, volume_success, power_success])
            
            if success_count == 3:
                logger.info("✅ Background collection: Successfully updated all data (market + power)")
                last_collection_time = current_time
            elif success_count >= 1:
                logger.warning(f"⚠️ Background collection: Partially successful ({success_count}/3 collectors)")
                last_collection_time = current_time
            else:
                logger.error("❌ Background collection: Failed to collect any data")
            
        except Exception as e:
            logger.error(f"❌ Background collection error: {str(e)}")
        
        # Wait 10 seconds before next collection (same as dashboard refresh)
        time.sleep(10)
    
    logger.info("🛑 Background data collector stopped")


def start_background_collection():
    """Start the background data collection thread."""
    global background_collection_active
    
    if not background_collection_active:
        background_collection_active = True
        collection_thread = threading.Thread(target=background_data_collector, daemon=True)
        collection_thread.start()
        logger.info("🚀 Background data collection started")


def stop_background_collection():
    """Stop the background data collection thread."""
    global background_collection_active
    background_collection_active = False
    logger.info("🛑 Background data collection stopped")


def main():
    """Run the web application."""
    # Create template if it doesn't exist
    if not (templates_dir / "dashboard.html").exists():
        create_dashboard_template()
    
    print("🌐 Starting Romanian Energy Balancing Market Dashboard")
    print("=" * 60)
    print("📊 Dashboard URL: http://localhost:8000")
    print("🔗 API Documentation: http://localhost:8000/docs")
    print("❤️ Health Check: http://localhost:8000/health")
    print("🤖 Background Data Collection: Every 10 seconds")
    print("=" * 60)
    
    # Start background data collection
    start_background_collection()
    
    try:
        # Run the application
        uvicorn.run(
            "src.web.app:app",
            host="0.0.0.0",
            port=8000,
            reload=True,
            log_level="info"
        )
    finally:
        # Stop background collection when app shuts down
        stop_background_collection()


if __name__ == "__main__":
    main()
