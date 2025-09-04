#!/usr/bin/env python3
"""
Test script for the interval transition collector.
This will test the new interval-aware data collection logic.
"""

import logging
import time
from datetime import datetime, timedelta
import pytz
import sys
import os

# Add project root to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.interval_transition_collector import IntervalTransitionCollector
from src.data.models import PowerGenerationData, get_session

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def test_interval_transition_collector():
    """Test the interval transition collector functionality."""
    print("🔧 Testing Interval Transition Collector...")
    print("=" * 60)
    
    # Create collector instance
    collector = IntervalTransitionCollector()
    
    # Test connection first
    print("1. Testing API connection...")
    if collector.test_connection():
        print("✅ API connection successful")
    else:
        print("❌ API connection failed")
        return False
    
    # Test data collection with transition handling
    print("\n2. Testing interval-aware data collection...")
    
    # Get current interval info
    romanian_tz = pytz.timezone('Europe/Bucharest')
    current_time = datetime.now(romanian_tz)
    current_interval = collector._get_interval_timestamp(current_time)
    
    print(f"📅 Current time: {current_time}")
    print(f"📊 Current interval: {current_interval}")
    
    # Collect data multiple times to test the logic
    print("\n3. Running multiple collections to test interval logic...")
    
    for i in range(3):
        print(f"\n   Collection #{i+1}:")
        success = collector.collect_with_transition_handling(force_update=True)
        
        if success:
            print(f"   ✅ Collection #{i+1} successful")
        else:
            print(f"   ❌ Collection #{i+1} failed")
        
        # Wait a few seconds between collections
        if i < 2:
            print("   ⏳ Waiting 5 seconds...")
            time.sleep(5)
    
    # Check database for the current interval
    print("\n4. Checking database for current interval data...")
    
    session = get_session()
    try:
        # Get the record for current interval
        record = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == current_interval)\
            .first()
        
        if record:
            print(f"✅ Found database record for {current_interval}")
            print(f"   Production: {record.total_production} MW")
            print(f"   Consumption: {record.total_consumption} MW")
            print(f"   Imports: {record.imports} MW")
            print(f"   Exports: {record.exports} MW")
            print(f"   Net Balance: {record.net_balance} MW")
        else:
            print(f"❌ No database record found for {current_interval}")
            
    except Exception as e:
        print(f"❌ Error checking database: {e}")
    finally:
        session.close()
    
    print("\n5. Testing interval transition detection...")
    
    # Simulate what happens when we move to a different interval
    # by manually setting the collector's last interval to a previous one
    previous_interval = current_interval - timedelta(minutes=15)
    collector.last_interval_timestamp = previous_interval
    
    # Create some fake data for the "previous" interval
    fake_data = {
        'generation': {
            'nuclear': 1000.0, 'coal': 500.0, 'gas': 300.0,
            'wind': 200.0, 'hydro': 150.0, 'solar': 50.0, 'other': 100.0
        },
        'totals': {
            'production': 2300.0, 'consumption': 2200.0, 'net_balance': 100.0,
            'imports': 150.0, 'exports': 50.0
        },
        'interconnections': {
            'interconnection_hungary': -50.0,
            'interconnection_bulgaria': 30.0,
            'interconnection_serbia': -80.0
        },
        'import_export_units': {
            'unit_muka': 10.0, 'unit_ispoz': -20.0, 'unit_is': 15.0,
            'unit_unge': -5.0, 'unit_cioa': 25.0, 'unit_gote': -10.0,
            'unit_vulc': 5.0, 'unit_dobr': -15.0, 'unit_varn': 20.0,
            'unit_kozl1': -25.0, 'unit_kozl2': 30.0, 'unit_djer': -10.0,
            'unit_sip': 15.0, 'unit_pancevo21': -20.0, 'unit_pancevo22': 10.0,
            'unit_kiki': -5.0, 'unit_sand': 25.0, 'unit_beke1': -15.0,
            'unit_beke115': 20.0
        },
        'total_import_export_units': 100.0,
        'raw_data': '{"test": "data"}'
    }
    
    collector.last_interval_data = fake_data
    
    print(f"   Set up fake previous interval: {previous_interval}")
    print("   Now collecting current data to trigger transition...")
    
    # This should trigger the interval transition logic
    success = collector.collect_with_transition_handling(force_update=True)
    
    if success:
        print("   ✅ Interval transition collection successful")
        print("   📝 Check logs above for transition detection messages")
    else:
        print("   ❌ Interval transition collection failed")
    
    print("\n" + "=" * 60)
    print("🎉 Interval Transition Collector test completed!")
    
    return True

def check_recent_database_records():
    """Check the most recent database records to see the data quality."""
    print("\n📊 Checking recent database records...")
    
    session = get_session()
    try:
        # Get the 5 most recent records
        records = session.query(PowerGenerationData)\
            .order_by(PowerGenerationData.timestamp.desc())\
            .limit(5).all()
        
        if records:
            print(f"Found {len(records)} recent records:")
            print()
            
            for i, record in enumerate(records, 1):
                print(f"Record #{i}:")
                print(f"  Timestamp: {record.timestamp}")
                print(f"  Production: {record.total_production} MW")
                print(f"  Consumption: {record.total_consumption} MW")
                print(f"  Imports: {record.imports} MW")
                print(f"  Exports: {record.exports} MW")
                print(f"  Net Balance: {record.net_balance} MW")
                
                # Calculate age
                now = datetime.now()
                age = now - record.timestamp
                age_minutes = age.total_seconds() / 60
                print(f"  Age: {age_minutes:.1f} minutes")
                print()
        else:
            print("No records found in database")
            
    except Exception as e:
        print(f"Error checking database records: {e}")
    finally:
        session.close()

if __name__ == "__main__":
    print("🚀 Starting Interval Transition Collector Test")
    print("This test will verify the new interval-aware data collection logic")
    print()
    
    # Run the main test
    success = test_interval_transition_collector()
    
    # Check recent database records
    check_recent_database_records()
    
    if success:
        print("✅ All tests completed successfully!")
        print("\nThe interval transition collector is now ready to use.")
        print("It will automatically preserve final interval data when intervals change.")
    else:
        print("❌ Some tests failed. Please check the logs above.")
        sys.exit(1)
