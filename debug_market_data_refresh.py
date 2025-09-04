#!/usr/bin/env python3
"""
Debug script to check why Actual Market Data is not refreshing after the database fixes.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.models import PowerGenerationData, get_session
from src.data.power_generation_collector import PowerGenerationCollector
from datetime import datetime, timedelta
import pytz

def debug_market_data_refresh():
    """Debug market data refresh issues."""
    print("🔍 DEBUGGING MARKET DATA REFRESH ISSUES")
    print("=" * 80)
    
    # Romanian timezone
    romanian_tz = pytz.timezone('Europe/Bucharest')
    current_time = datetime.now(romanian_tz)
    
    print(f"📅 Current time: {current_time}")
    
    # 1. Test PowerGenerationCollector
    print("\n1️⃣ TESTING POWER GENERATION COLLECTOR")
    print("-" * 50)
    
    try:
        collector = PowerGenerationCollector()
        print("✅ PowerGenerationCollector created successfully")
        
        # Test get_latest_data
        latest_data = collector.get_latest_data()
        if latest_data:
            print("✅ get_latest_data() working")
            print(f"   Latest timestamp: {latest_data['timestamp']}")
            print(f"   Production: {latest_data['totals']['production']} MW")
            print(f"   Consumption: {latest_data['totals']['consumption']} MW")
        else:
            print("❌ get_latest_data() returned None")
        
        # Test live API fetch
        live_data = collector.client.fetch_power_data()
        if live_data:
            print("✅ Live API fetch working")
            print(f"   Production: {live_data['totals']['production']} MW")
            print(f"   Consumption: {live_data['totals']['consumption']} MW")
        else:
            print("❌ Live API fetch failed")
            
    except Exception as e:
        print(f"❌ PowerGenerationCollector error: {e}")
        import traceback
        traceback.print_exc()
    
    # 2. Check database connectivity and recent records
    print("\n2️⃣ CHECKING DATABASE CONNECTIVITY")
    print("-" * 50)
    
    try:
        session = get_session()
        
        # Check if we can query the database
        total_records = session.query(PowerGenerationData).count()
        print(f"✅ Database connection working - Total records: {total_records}")
        
        # Check most recent record
        latest_record = session.query(PowerGenerationData)\
            .order_by(PowerGenerationData.timestamp.desc())\
            .first()
        
        if latest_record:
            print(f"✅ Latest record found:")
            print(f"   ID: {latest_record.id}")
            print(f"   Timestamp: {latest_record.timestamp}")
            print(f"   Production: {latest_record.total_production} MW")
            print(f"   Consumption: {latest_record.total_consumption} MW")
            print(f"   Created: {latest_record.created_at}")
            print(f"   Updated: {latest_record.updated_at}")
            
            # Check if it's recent
            time_diff = current_time.replace(tzinfo=None) - latest_record.timestamp
            print(f"   Age: {time_diff}")
            
            if time_diff > timedelta(minutes=30):
                print("   ⚠️ Latest record is more than 30 minutes old")
            else:
                print("   ✅ Latest record is recent")
        else:
            print("❌ No records found in database")
        
        session.close()
        
    except Exception as e:
        print(f"❌ Database error: {e}")
        import traceback
        traceback.print_exc()
    
    # 3. Test data collection
    print("\n3️⃣ TESTING DATA COLLECTION")
    print("-" * 50)
    
    try:
        collector = PowerGenerationCollector()
        
        # Try to collect current data
        print("Attempting to collect current data...")
        success = collector.collect_current_data(force_update=True)
        
        if success:
            print("✅ Data collection successful")
        else:
            print("❌ Data collection failed")
            
    except Exception as e:
        print(f"❌ Data collection error: {e}")
        import traceback
        traceback.print_exc()
    
    # 4. Check if our fixes broke anything
    print("\n4️⃣ CHECKING FOR BROKEN FUNCTIONALITY")
    print("-" * 50)
    
    try:
        session = get_session()
        
        # Check if we have any records with NULL values that shouldn't be NULL
        null_production = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.total_production.is_(None))\
            .count()
        
        null_consumption = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.total_consumption.is_(None))\
            .count()
        
        print(f"Records with NULL production: {null_production}")
        print(f"Records with NULL consumption: {null_consumption}")
        
        if null_production > 0 or null_consumption > 0:
            print("⚠️ Found NULL values in critical fields")
        else:
            print("✅ No NULL values in critical fields")
        
        # Check for any records with extreme values that might indicate corruption
        extreme_records = session.query(PowerGenerationData)\
            .filter(
                (PowerGenerationData.total_production < 0) |
                (PowerGenerationData.total_production > 20000) |
                (PowerGenerationData.total_consumption < 0) |
                (PowerGenerationData.total_consumption > 20000)
            ).count()
        
        print(f"Records with extreme values: {extreme_records}")
        
        if extreme_records > 0:
            print("⚠️ Found records with extreme values")
        else:
            print("✅ No extreme values found")
        
        session.close()
        
    except Exception as e:
        print(f"❌ Data validation error: {e}")
        import traceback
        traceback.print_exc()
    
    # 5. Test web API endpoints
    print("\n5️⃣ TESTING WEB API ENDPOINTS")
    print("-" * 50)
    
    try:
        import requests
        
        # Test power generation intervals endpoint
        response = requests.get('http://localhost:5000/api/power-generation-intervals', timeout=10)
        if response.status_code == 200:
            print("✅ Power generation intervals endpoint working")
            data = response.json()
            print(f"   Current interval: {data.get('current_interval')}")
            print(f"   Total intervals: {len(data.get('intervals', []))}")
        else:
            print(f"❌ Power generation intervals endpoint failed: {response.status_code}")
        
        # Test power generation data endpoint
        response = requests.get('http://localhost:5000/api/power-generation', timeout=10)
        if response.status_code == 200:
            print("✅ Power generation data endpoint working")
            data = response.json()
            if data.get('data'):
                print(f"   Data timestamp: {data['data'].get('timestamp')}")
                print(f"   Production: {data['data']['totals'].get('production')} MW")
            else:
                print("❌ No data in power generation endpoint response")
        else:
            print(f"❌ Power generation data endpoint failed: {response.status_code}")
            
    except Exception as e:
        print(f"❌ Web API test error: {e}")
    
    print("\n" + "=" * 80)
    print("🎯 MARKET DATA REFRESH DEBUG COMPLETE")
    print("=" * 80)

if __name__ == "__main__":
    debug_market_data_refresh()
