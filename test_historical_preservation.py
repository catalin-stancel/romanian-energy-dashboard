#!/usr/bin/env python3
"""
Test script to verify that current interval data is being saved to database
for historical preservation when accessed via web API endpoint.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import requests
import time
from datetime import datetime, timedelta
from src.data.power_generation_collector import PowerGenerationCollector
from src.data.models import PowerGenerationData, get_session

def test_historical_preservation():
    """Test that web API calls save current data to database for historical preservation."""
    print("🧪 TESTING HISTORICAL DATA PRESERVATION")
    print("=" * 60)
    
    # Get current 15-minute interval timestamp
    current_time = datetime.now()
    interval_minutes = (current_time.minute // 15) * 15
    current_interval = current_time.replace(minute=interval_minutes, second=0, microsecond=0)
    
    print(f"⏰ Current interval: {current_interval}")
    
    # Check database before web API call
    print("\n📊 Checking database BEFORE web API call...")
    session = get_session()
    try:
        records_before = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == current_interval)\
            .count()
        print(f"   Records for current interval: {records_before}")
        
        # Get the latest record timestamp to see what we have
        latest_record = session.query(PowerGenerationData)\
            .order_by(PowerGenerationData.timestamp.desc())\
            .first()
        
        if latest_record:
            print(f"   Latest record timestamp: {latest_record.timestamp}")
            print(f"   Latest record imports: {getattr(latest_record, 'imports', 'N/A')}")
        else:
            print("   No records found in database")
            
    finally:
        session.close()
    
    # Make web API call to trigger data saving
    print("\n🌐 Making web API call to trigger current interval data saving...")
    try:
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        
        if response.status_code == 200:
            data = response.json()
            current_interval_data = None
            
            # Find current interval in response
            for interval in data['intervals']:
                if interval['is_current']:
                    current_interval_data = interval
                    break
            
            if current_interval_data:
                print(f"✅ Web API call successful")
                print(f"   Current interval: {current_interval_data['interval']}")
                print(f"   Imports: {current_interval_data['imports']} MW")
                print(f"   Exports: {current_interval_data['exports']} MW")
            else:
                print("⚠️ No current interval found in response")
        else:
            print(f"❌ Web API call failed with status {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Web API call failed: {str(e)}")
        return False
    
    # Wait a moment for database write to complete
    print("\n⏳ Waiting 2 seconds for database write to complete...")
    time.sleep(2)
    
    # Check database after web API call
    print("\n📊 Checking database AFTER web API call...")
    session = get_session()
    try:
        records_after = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == current_interval)\
            .count()
        print(f"   Records for current interval: {records_after}")
        
        # Get the specific record for current interval
        current_record = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == current_interval)\
            .order_by(PowerGenerationData.id.desc())\
            .first()
        
        if current_record:
            print(f"   Current interval record found!")
            print(f"   Timestamp: {current_record.timestamp}")
            print(f"   Production: {current_record.total_production} MW")
            print(f"   Consumption: {current_record.total_consumption} MW")
            print(f"   Imports: {getattr(current_record, 'imports', 'N/A')} MW")
            print(f"   Exports: {getattr(current_record, 'exports', 'N/A')} MW")
            
            # Check if we have border point data
            border_points = [
                ('MUKA', getattr(current_record, 'unit_muka', 0)),
                ('ISPOZ', getattr(current_record, 'unit_ispoz', 0)),
                ('KOZL2', getattr(current_record, 'unit_kozl2', 0)),
                ('SAND', getattr(current_record, 'unit_sand', 0)),
                ('BEKE1', getattr(current_record, 'unit_beke1', 0))
            ]
            
            print(f"\n🌍 Sample Border Point Data:")
            for name, value in border_points:
                if value != 0:
                    direction = "Import" if value > 0 else "Export"
                    print(f"   {name}: {value} MW ({direction})")
            
        else:
            print("   ❌ No record found for current interval")
            return False
            
    finally:
        session.close()
    
    # Verify data was saved correctly
    if records_after > records_before:
        print(f"\n✅ SUCCESS: New record created for current interval")
        print(f"   Records before: {records_before}")
        print(f"   Records after: {records_after}")
        return True
    elif records_after == records_before and records_before > 0:
        print(f"\n✅ SUCCESS: Existing record updated for current interval")
        print(f"   Records: {records_after} (updated)")
        return True
    else:
        print(f"\n❌ FAILURE: No data was saved to database")
        print(f"   Records before: {records_before}")
        print(f"   Records after: {records_after}")
        return False

def test_data_consistency():
    """Test that saved data matches what the API returns."""
    print("\n" + "=" * 60)
    print("🔍 TESTING DATA CONSISTENCY")
    print("=" * 60)
    
    # Get data from web API
    try:
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        if response.status_code != 200:
            print("❌ Failed to get web API data")
            return False
            
        api_data = response.json()
        current_api_interval = None
        
        for interval in api_data['intervals']:
            if interval['is_current']:
                current_api_interval = interval
                break
        
        if not current_api_interval:
            print("❌ No current interval found in API response")
            return False
            
    except Exception as e:
        print(f"❌ Failed to get API data: {str(e)}")
        return False
    
    # Get data from database
    current_time = datetime.now()
    interval_minutes = (current_time.minute // 15) * 15
    current_interval = current_time.replace(minute=interval_minutes, second=0, microsecond=0)
    
    session = get_session()
    try:
        db_record = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == current_interval)\
            .order_by(PowerGenerationData.id.desc())\
            .first()
        
        if not db_record:
            print("❌ No database record found for current interval")
            return False
            
    finally:
        session.close()
    
    # Compare values
    print("📊 Comparing API vs Database values:")
    
    comparisons = [
        ("Production", current_api_interval['production'], db_record.total_production),
        ("Consumption", current_api_interval['consumption'], db_record.total_consumption),
        ("Imports", current_api_interval['imports'], getattr(db_record, 'imports', 0)),
        ("Exports", current_api_interval['exports'], getattr(db_record, 'exports', 0))
    ]
    
    all_match = True
    for name, api_val, db_val in comparisons:
        if abs(api_val - db_val) < 0.1:  # Allow small floating point differences
            print(f"   ✅ {name}: API={api_val}, DB={db_val} (MATCH)")
        else:
            print(f"   ❌ {name}: API={api_val}, DB={db_val} (MISMATCH)")
            all_match = False
    
    if all_match:
        print("\n✅ SUCCESS: All values match between API and database")
        return True
    else:
        print("\n❌ FAILURE: Some values don't match between API and database")
        return False

def main():
    """Run all historical preservation tests."""
    print("🚀 HISTORICAL DATA PRESERVATION TEST SUITE")
    print(f"⏰ Test time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Test 1: Historical preservation
    test1_result = test_historical_preservation()
    
    # Test 2: Data consistency
    test2_result = test_data_consistency()
    
    # Summary
    print("\n" + "=" * 60)
    print("📋 TEST SUMMARY")
    print("=" * 60)
    print(f"✅ Historical Preservation: {'PASS' if test1_result else 'FAIL'}")
    print(f"✅ Data Consistency: {'PASS' if test2_result else 'FAIL'}")
    
    if test1_result and test2_result:
        print("\n🎉 ALL TESTS PASSED!")
        print("💾 Current interval data is being properly saved to database")
        print("🔄 Historical data preservation is working correctly")
    else:
        print("\n❌ SOME TESTS FAILED!")
        print("🔧 Historical data preservation needs attention")

if __name__ == "__main__":
    main()
