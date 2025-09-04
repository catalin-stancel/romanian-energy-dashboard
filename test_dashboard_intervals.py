#!/usr/bin/env python3

import requests
import json
import sys

def test_dashboard_intervals():
    """Test the power generation intervals endpoint that feeds the dashboard."""
    
    print("🔍 Testing Dashboard Power Generation Intervals Endpoint")
    print("=" * 60)
    
    try:
        # Test the endpoint that the dashboard uses
        url = "http://localhost:8000/api/power-generation-intervals"
        
        print(f"📡 Making request to: {url}")
        response = requests.get(url, timeout=10)
        
        if response.status_code != 200:
            print(f"❌ HTTP Error: {response.status_code}")
            print(f"Response: {response.text}")
            return False
        
        data = response.json()
        
        print(f"✅ Response received successfully")
        print(f"📅 Date: {data.get('date', 'N/A')}")
        print(f"📊 Total intervals: {len(data.get('intervals', []))}")
        print(f"⏰ Current interval: {data.get('current_interval', 'N/A')}")
        
        # Find the current interval data
        intervals = data.get('intervals', [])
        current_interval_idx = data.get('current_interval', 0) - 1
        
        if 0 <= current_interval_idx < len(intervals):
            current_data = intervals[current_interval_idx]
            print(f"\n🎯 Current Interval Data:")
            print(f"   Time: {current_data.get('time', 'N/A')}")
            print(f"   Production: {current_data.get('production', 'N/A')} MW")
            print(f"   Consumption: {current_data.get('consumption', 'N/A')} MW")
            print(f"   Imports: {current_data.get('imports', 'N/A')} MW")
            print(f"   Exports: {current_data.get('exports', 'N/A')} MW")
            print(f"   Net Balance: {current_data.get('net_balance', 'N/A')} MW")
            print(f"   Status: {current_data.get('status', 'N/A')}")
        
        # Check the last few intervals for imports/exports data
        print(f"\n📈 Last 5 Intervals Imports/Exports:")
        for i, interval in enumerate(intervals[-5:]):
            idx = len(intervals) - 5 + i + 1
            time = interval.get('time', 'N/A')
            imports = interval.get('imports', 'N/A')
            exports = interval.get('exports', 'N/A')
            print(f"   {idx:2d}. {time}: Imports={imports} MW, Exports={exports} MW")
        
        # Check if any intervals have non-zero imports/exports
        non_zero_imports = [i for i in intervals if i.get('imports', 0) and i.get('imports', 0) > 0]
        non_zero_exports = [i for i in intervals if i.get('exports', 0) and i.get('exports', 0) > 0]
        
        print(f"\n📊 Summary:")
        print(f"   Intervals with imports > 0: {len(non_zero_imports)}")
        print(f"   Intervals with exports > 0: {len(non_zero_exports)}")
        
        if non_zero_imports:
            print(f"   Max imports: {max(i.get('imports', 0) for i in non_zero_imports)} MW")
        if non_zero_exports:
            print(f"   Max exports: {max(i.get('exports', 0) for i in non_zero_exports)} MW")
        
        return True
        
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")
        return False
    except json.JSONDecodeError as e:
        print(f"❌ JSON decode error: {e}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return False

if __name__ == "__main__":
    success = test_dashboard_intervals()
    sys.exit(0 if success else 1)
