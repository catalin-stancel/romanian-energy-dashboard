#!/usr/bin/env python3
"""
Test script to verify the dashboard fix is working correctly.
"""

import requests
import json
from datetime import datetime

def test_dashboard_api():
    """Test the fixed dashboard API endpoint."""
    print("🔧 Testing Dashboard API Fix")
    print("=" * 50)
    
    try:
        # Test the power generation intervals endpoint
        print("📡 Calling /api/power-generation-intervals...")
        response = requests.get('http://localhost:8000/api/power-generation-intervals', timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ API responded successfully")
            print(f"📊 Total intervals: {len(data.get('intervals', []))}")
            print(f"🕐 Current interval: {data.get('current_interval')}")
            print(f"📈 Historical intervals: {data.get('historical_intervals')}")
            
            # Check specific intervals
            intervals = data.get('intervals', [])
            
            print(f"\n🔍 Checking key intervals:")
            
            # Find 17:30 and 17:45 intervals
            interval_1730 = None
            interval_1745 = None
            
            for interval in intervals:
                if interval['time'] == '17:30':
                    interval_1730 = interval
                elif interval['time'] == '17:45':
                    interval_1745 = interval
            
            if interval_1730:
                print(f"\n📋 17:30 Interval (Historical):")
                print(f"   Production: {interval_1730.get('production')} MW")
                print(f"   Consumption: {interval_1730.get('consumption')} MW")
                print(f"   Imports: {interval_1730.get('imports')} MW")
                print(f"   Exports: {interval_1730.get('exports')} MW")
                print(f"   Net Balance: {interval_1730.get('net_balance')} MW")
                print(f"   Status: {interval_1730.get('status')}")
                print(f"   Is Current: {interval_1730.get('is_current')}")
                print(f"   Has Data: {interval_1730.get('has_data')}")
                
                # Check if imports/exports match database values
                expected_imports = 1383.0
                expected_exports = 434.0
                actual_imports = interval_1730.get('imports', 0)
                actual_exports = interval_1730.get('exports', 0)
                
                if abs(actual_imports - expected_imports) < 1.0:
                    print(f"   ✅ Imports match database: {actual_imports} MW")
                else:
                    print(f"   ❌ Import mismatch: Expected {expected_imports}, Got {actual_imports}")
                
                if abs(actual_exports - expected_exports) < 1.0:
                    print(f"   ✅ Exports match database: {actual_exports} MW")
                else:
                    print(f"   ❌ Export mismatch: Expected {expected_exports}, Got {actual_exports}")
            else:
                print(f"   ❌ 17:30 interval not found")
            
            if interval_1745:
                print(f"\n📋 17:45 Interval:")
                print(f"   Production: {interval_1745.get('production')} MW")
                print(f"   Consumption: {interval_1745.get('consumption')} MW")
                print(f"   Imports: {interval_1745.get('imports')} MW")
                print(f"   Exports: {interval_1745.get('exports')} MW")
                print(f"   Net Balance: {interval_1745.get('net_balance')} MW")
                print(f"   Status: {interval_1745.get('status')}")
                print(f"   Is Current: {interval_1745.get('is_current')}")
                print(f"   Has Data: {interval_1745.get('has_data')}")
            else:
                print(f"   ❌ 17:45 interval not found")
            
            print(f"\n🎯 Dashboard Fix Status:")
            if interval_1730 and abs(interval_1730.get('imports', 0) - 1383.0) < 1.0:
                print(f"   ✅ FIXED: 17:30 interval now shows correct database values")
                print(f"   ✅ Historical intervals use database data")
                print(f"   ✅ Dashboard discrepancy resolved")
                return True
            else:
                print(f"   ❌ STILL BROKEN: 17:30 interval shows incorrect values")
                return False
                
        else:
            print(f"❌ API returned status code: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except requests.exceptions.ConnectionError:
        print("⚠️  Dashboard API not accessible (server may not be running)")
        print("💡 Start the server with: python src/web/app.py")
        return False
    except Exception as e:
        print(f"❌ Test failed: {e}")
        return False

def main():
    print("🧪 Dashboard Fix Verification Test\n")
    
    success = test_dashboard_api()
    
    print(f"\n{'='*50}")
    if success:
        print(f"🎉 DASHBOARD FIX SUCCESSFUL!")
        print(f"✅ Historical intervals now show correct database values")
        print(f"✅ 17:30 data displays properly preserved imports/exports")
        print(f"✅ Dashboard discrepancy resolved")
    else:
        print(f"❌ DASHBOARD FIX FAILED!")
        print(f"⚠️  Dashboard still shows incorrect values")
        print(f"🔧 Additional debugging may be required")

if __name__ == "__main__":
    main()
