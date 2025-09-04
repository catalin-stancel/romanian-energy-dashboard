#!/usr/bin/env python3
"""
Debug the web endpoint to see what's causing the 500 error.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.data.power_generation_collector import PowerGenerationCollector
from datetime import datetime, timedelta
import traceback

def debug_web_endpoint():
    """Simulate what the web endpoint does to find the error."""
    try:
        print("🔍 Debugging web endpoint logic...")
        
        # Initialize collector (same as web app)
        power_collector = PowerGenerationCollector()
        
        # Parse target date (same as web endpoint)
        date = datetime.now()
        
        # Get start and end of the day (same as web endpoint)
        start_date = date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        print(f"📅 Date range: {start_date} to {end_date}")
        
        # Get interval-based power generation data for the day
        print("📊 Getting interval data...")
        interval_power_data = power_collector.get_interval_data(start_date, end_date)
        print(f"✅ Found {len(interval_power_data)} intervals")
        
        # Get latest data for current interval
        print("🔄 Getting latest data...")
        latest_power_data = power_collector.get_latest_data()
        if latest_power_data:
            print(f"✅ Latest data: {latest_power_data['totals']['production']}MW production")
        else:
            print("❌ No latest data available")
        
        # Test creating intervals (simplified version)
        print("🔧 Testing interval creation...")
        intervals = []
        
        for i in range(3):  # Test just first 3 intervals
            interval_start = start_date + timedelta(minutes=i * 15)
            
            # Try to get historical data for this interval first
            power_data = interval_power_data.get(interval_start)
            
            # If no historical data and this is current interval, use latest data
            if not power_data and latest_power_data:
                power_data = latest_power_data
            
            print(f"   Interval {i+1} ({interval_start}): {'Has data' if power_data else 'No data'}")
            
            if power_data:
                # Test accessing the data structure
                production = power_data['totals']['production']
                consumption = power_data['totals']['consumption']
                net_balance = power_data['totals']['net_balance']
                interconnections = power_data['interconnections']
                
                print(f"     Production: {production}MW, Consumption: {consumption}MW, Balance: {net_balance}MW")
        
        print("✅ Web endpoint logic works fine!")
        
    except Exception as e:
        print(f"❌ Error found: {e}")
        print("📋 Full traceback:")
        traceback.print_exc()

if __name__ == "__main__":
    debug_web_endpoint()
