#!/usr/bin/env python3
"""
Test the API logic directly without running the web server.
"""

import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

from datetime import datetime, timedelta
from src.data.power_generation_collector import PowerGenerationCollector

def test_power_generation_logic():
    """Test the power generation logic directly."""
    print("🔧 Testing Power Generation Logic Directly")
    print("=" * 50)
    
    try:
        # Create a fresh collector instance
        print("📊 Creating PowerGenerationCollector...")
        collector = PowerGenerationCollector()
        
        # Test get_latest_data
        print("📡 Testing get_latest_data()...")
        latest_data = collector.get_latest_data()
        
        if not latest_data:
            print("❌ No latest data available")
            return False
        
        print(f"✅ Latest data retrieved successfully")
        print(f"   Timestamp: {latest_data['timestamp']}")
        print(f"   Production: {latest_data['totals']['production']} MW")
        print(f"   Consumption: {latest_data['totals']['consumption']} MW")
        print(f"   Imports: {latest_data['totals'].get('imports', 'N/A')} MW")
        print(f"   Exports: {latest_data['totals'].get('exports', 'N/A')} MW")
        
        # Test get_interval_data
        print(f"\n📊 Testing get_interval_data()...")
        current_time = datetime.now()
        start_date = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        historical_data = collector.get_interval_data(start_date, end_date)
        print(f"✅ Historical data retrieved: {len(historical_data)} intervals")
        
        # Check specific intervals
        interval_1730 = None
        interval_1745 = None
        
        for timestamp, data in historical_data.items():
            time_str = timestamp.strftime("%H:%M")
            if time_str == "17:30":
                interval_1730 = data
            elif time_str == "17:45":
                interval_1745 = data
        
        if interval_1730:
            print(f"\n📋 17:30 Historical Data:")
            print(f"   Production: {interval_1730['totals']['production']} MW")
            print(f"   Consumption: {interval_1730['totals']['consumption']} MW")
            print(f"   Net Balance: {interval_1730['totals']['net_balance']} MW")
            print(f"   Interconnections: {interval_1730['interconnections']}")
        else:
            print(f"❌ 17:30 interval not found in historical data")
        
        if interval_1745:
            print(f"\n📋 17:45 Historical Data:")
            print(f"   Production: {interval_1745['totals']['production']} MW")
            print(f"   Consumption: {interval_1745['totals']['consumption']} MW")
            print(f"   Net Balance: {interval_1745['totals']['net_balance']} MW")
            print(f"   Interconnections: {interval_1745['interconnections']}")
        else:
            print(f"❌ 17:45 interval not found in historical data")
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing power generation logic: {e}")
        import traceback
        print(f"Traceback: {traceback.format_exc()}")
        return False

def test_web_app_syntax():
    """Test if the web app has syntax errors."""
    print(f"\n🔧 Testing Web App Syntax")
    print("=" * 50)
    
    try:
        print("📝 Importing web app module...")
        sys.path.append('src')
        from web import app
        print("✅ Web app imports successfully - no syntax errors")
        return True
    except Exception as e:
        print(f"❌ Web app has syntax errors: {e}")
        import traceback
        print(f"Traceback: {traceback.format_exc()}")
        return False

def main():
    print("🧪 Direct API Logic Test\n")
    
    # Test web app syntax first
    syntax_ok = test_web_app_syntax()
    
    # Test power generation logic
    logic_ok = test_power_generation_logic()
    
    print(f"\n{'='*50}")
    print(f"📊 Test Results:")
    print(f"   Web App Syntax: {'✅ OK' if syntax_ok else '❌ BROKEN'}")
    print(f"   Power Logic: {'✅ OK' if logic_ok else '❌ BROKEN'}")
    
    if syntax_ok and logic_ok:
        print(f"\n🎉 API logic is working correctly!")
        print(f"💡 You can now start the web server to test the dashboard")
    else:
        print(f"\n❌ Issues found that need to be fixed")

if __name__ == "__main__":
    main()
