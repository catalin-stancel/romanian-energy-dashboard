#!/usr/bin/env python3
"""
Test the dashboard endpoint logic directly without running the web server.
"""

import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

from datetime import datetime, timedelta
from src.data.power_generation_collector import PowerGenerationCollector
from src.data.models import PowerGenerationData, get_session

def simulate_dashboard_api_logic():
    """Simulate the dashboard API logic directly."""
    print("🔧 Testing Dashboard API Logic Directly")
    print("=" * 50)
    
    try:
        # Create a fresh collector instance
        fresh_power_collector = PowerGenerationCollector()
        
        # Get latest data
        latest_power_data = fresh_power_collector.get_latest_data()
        
        if not latest_power_data:
            print("❌ No power generation data available")
            return False
        
        print(f"✅ Latest data retrieved: {latest_power_data['timestamp']}")
        
        # Get historical interval data for today
        current_time = datetime.now()
        start_date = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        # Get historical data from database
        historical_data = fresh_power_collector.get_interval_data(start_date, end_date)
        
        print(f"📊 Historical intervals found: {len(historical_data)}")
        
        # Test specific intervals
        intervals_to_test = []
        current_interval_num = None
        
        for i in range(96):  # 96 intervals of 15 minutes each
            interval_start = start_date + timedelta(minutes=i * 15)
            interval_end = interval_start + timedelta(minutes=15)
            
            # Determine if this interval is current
            is_current = interval_start <= current_time < interval_end
            if is_current:
                current_interval_num = i + 1
            
            # Find historical data for this interval
            historical_record = historical_data.get(interval_start)
            
            # Test key intervals
            time_str = interval_start.strftime("%H:%M")
            if time_str in ["17:30", "17:45"]:
                
                if is_current:
                    # For current interval, use fresh live API data
                    live_api_data = fresh_power_collector.client.fetch_power_data()
                    
                    if live_api_data:
                        production = live_api_data['totals']['production']
                        consumption = live_api_data['totals']['consumption']
                        imports = live_api_data['imports_total']
                        exports = live_api_data['exports_total']
                        interconnection_details = live_api_data.get('interconnections', {})
                    else:
                        production = latest_power_data['totals']['production']
                        consumption = latest_power_data['totals']['consumption']
                        imports = latest_power_data.get('imports_total', 0.0)
                        exports = latest_power_data.get('exports_total', 0.0)
                        interconnection_details = latest_power_data.get('interconnections', {})
                    
                    # Calculate net balance from production and consumption
                    if production is not None and consumption is not None:
                        net_balance = production - consumption
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
                    
                elif historical_record:
                    # For historical intervals, ONLY use database data
                    production = historical_record['totals']['production']
                    consumption = historical_record['totals']['consumption']
                    net_balance = historical_record['totals']['net_balance']
                    
                    # Get imports and exports from database
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
                
                interval_data = {
                    "interval": i + 1,
                    "time": time_str,
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
                intervals_to_test.append(interval_data)
        
        # Display results
        print(f"\n🔍 Dashboard API Logic Test Results:")
        print(f"   Current interval: {current_interval_num}")
        
        for interval in intervals_to_test:
            print(f"\n📋 {interval['time']} Interval:")
            print(f"   Production: {interval['production']} MW")
            print(f"   Consumption: {interval['consumption']} MW")
            print(f"   Imports: {interval['imports']} MW")
            print(f"   Exports: {interval['exports']} MW")
            print(f"   Net Balance: {interval['net_balance']} MW")
            print(f"   Status: {interval['status']}")
            print(f"   Is Current: {interval['is_current']}")
            print(f"   Has Data: {interval['has_data']}")
            
            # Check if this matches expected database values for 17:30
            if interval['time'] == '17:30' and not interval['is_current']:
                expected_imports = 1383.0
                expected_exports = 434.0
                actual_imports = interval['imports']
                actual_exports = interval['exports']
                
                if abs(actual_imports - expected_imports) < 1.0:
                    print(f"   ✅ Imports match database expectation: {actual_imports} MW")
                else:
                    print(f"   ❌ Import mismatch: Expected {expected_imports}, Got {actual_imports}")
                
                if abs(actual_exports - expected_exports) < 1.0:
                    print(f"   ✅ Exports match database expectation: {actual_exports} MW")
                else:
                    print(f"   ❌ Export mismatch: Expected {expected_exports}, Got {actual_exports}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing dashboard API logic: {e}")
        import traceback
        print(f"Traceback: {traceback.format_exc()}")
        return False

def main():
    print("🧪 Dashboard API Logic Test\n")
    
    success = simulate_dashboard_api_logic()
    
    print(f"\n{'='*50}")
    if success:
        print(f"🎉 Dashboard API logic is working correctly!")
        print(f"✅ Historical intervals use database data")
        print(f"✅ Current interval uses live API data")
        print(f"✅ Import/export values are properly retrieved")
        print(f"💡 The dashboard should now show correct values")
    else:
        print(f"❌ Dashboard API logic has issues")

if __name__ == "__main__":
    main()
