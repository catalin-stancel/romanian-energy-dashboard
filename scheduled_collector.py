#!/usr/bin/env python3
"""
Scheduled data collector for Romanian Energy Balancing Market.
Runs automatically to collect the latest data from ENTSO-E API.
"""

import time
import logging
import schedule
from datetime import datetime, timedelta
import sys
import os

# Add project root to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.collector import DataCollector

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/scheduled_collector.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class ScheduledCollector:
    """Handles scheduled data collection."""
    
    def __init__(self):
        self.collector = DataCollector()
        logger.info("Scheduled collector initialized")
    
    def collect_latest_data(self):
        """Collect the latest available data."""
        try:
            logger.info("Starting scheduled data collection...")
            
            # Collect today's data with force_update to get latest
            today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            tomorrow = today + timedelta(days=1)
            
            # Collect both price and volume data for today
            price_success = self.collector.collect_imbalance_prices(
                today, tomorrow, force_update=True
            )
            volume_success = self.collector.collect_imbalance_volumes(
                today, tomorrow, force_update=True
            )
            
            if price_success and volume_success:
                logger.info("✅ Scheduled data collection completed successfully")
            elif price_success or volume_success:
                logger.warning("⚠️ Scheduled data collection partially successful")
            else:
                logger.error("❌ Scheduled data collection failed")
                
        except Exception as e:
            logger.error(f"Error in scheduled data collection: {str(e)}")
    
    def collect_recent_data(self):
        """Collect recent data (last 2 days) to catch any missed data."""
        try:
            logger.info("Starting recent data collection...")
            success = self.collector.collect_recent_data(days_back=2)
            
            if success:
                logger.info("✅ Recent data collection completed successfully")
            else:
                logger.error("❌ Recent data collection failed")
                
        except Exception as e:
            logger.error(f"Error in recent data collection: {str(e)}")
    
    def run_scheduler(self):
        """Run the scheduled data collection."""
        logger.info("Starting scheduled data collector...")
        logger.info("Schedule:")
        logger.info("- Every 15 minutes: Collect latest data")
        logger.info("- Every hour: Collect recent data (2 days back)")
        
        # Schedule data collection every 15 minutes (to match ENTSO-E data intervals)
        schedule.every(15).minutes.do(self.collect_latest_data)
        
        # Schedule recent data collection every hour (to catch any missed data)
        schedule.every().hour.do(self.collect_recent_data)
        
        # Run initial collection
        self.collect_latest_data()
        
        # Keep the scheduler running
        while True:
            try:
                schedule.run_pending()
                time.sleep(60)  # Check every minute
            except KeyboardInterrupt:
                logger.info("Scheduler stopped by user")
                break
            except Exception as e:
                logger.error(f"Error in scheduler: {str(e)}")
                time.sleep(60)  # Wait a minute before retrying


def main():
    """Main function to run the scheduled collector."""
    # Create logs directory if it doesn't exist
    os.makedirs('logs', exist_ok=True)
    
    print("🕒 Romanian Energy Market - Scheduled Data Collector")
    print("=" * 60)
    print("📊 Collecting data every 15 minutes")
    print("🔄 Recent data check every hour")
    print("📝 Logs: logs/scheduled_collector.log")
    print("=" * 60)
    print("Press Ctrl+C to stop")
    
    collector = ScheduledCollector()
    collector.run_scheduler()


if __name__ == "__main__":
    main()
