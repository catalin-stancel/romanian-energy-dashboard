#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from datetime import datetime, timedelta
from src.data.power_generation_collector import PowerGenerationCollector

def test_current_interval_logic():
    """Test the current interval logic to debug import/export values."""
    print("🔍 Testing Current Interval Logic")
    print("=" * 50)
    
    # Create fresh collector
    collector = PowerGenerationCollector()
    
    # Get latest data (what the web API uses)
    print("1. Testing get_latest_data()...")
    latest_data = collector.get_latest_data()
    
    if latest_data:
        print(f"✅ Latest data timestamp: {latest_data['timestamp']}")
        print(f"   Production: {latest_data['totals']['production']} MW")
        print(f"   Consumption: {latest_data['totals']['consumption']} MW")
        
        # Check for imports_total and exports_total in latest_data
        if 'imports_total' in latest_data:
            print(f"   Imports Total: {latest_data['imports_total']} MW")
        else:
            print("   ❌ No 'imports_total' in latest_data")
            
        if 'exports_total' in latest_data:
            print(f"   Exports Total: {latest_data['exports_total']} MW")
        else:
            print("   ❌ No 'exports_total' in latest_data")
            
        # Check totals structure
        if 'imports' in latest_data['totals']:
            print(f"   Totals Imports: {latest_data['totals']['imports']} MW")
        else:
            print("   ❌ No 'imports' in totals")
            
        if 'exports' in latest_data['totals']:
            print(f"   Totals Exports: {latest_data['totals']['exports']} MW")
        else:
            print("   ❌ No 'exports' in totals")
    else:
        print("❌ No latest data available")
        return
    
    print("\n2. Testing fresh live API data...")
    # Get fresh live API data (what the web API should use for current interval)
    live_api_data = collector.client.fetch_power_data()
    
    if live_api_data:
        print(f"✅ Live API data retrieved")
        print(f"   Production: {live_api_data['totals']['production']} MW")
        print(f"   Consumption: {live_api_data['totals']['consumption']} MW")
        
        # Check for imports_total and exports_total in live API data
        if 'imports_total' in live_api_data:
            print(f"   🎯 Live API Imports Total: {live_api_data['imports_total']} MW")
        else:
            print("   ❌ No 'imports_total' in live API data")
            
        if 'exports_total' in live_api_data:
            print(f"   🎯 Live API Exports Total: {live_api_data['exports_total']} MW")
        else:
            print("   ❌ No 'exports_total' in live API data")
            
        # Check totals structure in live API data
        if 'imports' in live_api_data['totals']:
            print(f"   Live API Totals Imports: {live_api_data['totals']['imports']} MW")
        else:
            print("   ❌ No 'imports' in live API totals")
            
        if 'exports' in live_api_data['totals']:
            print(f"   Live API Totals Exports: {live_api_data['totals']['exports']} MW")
        else:
            print("   ❌ No 'exports' in live API totals")
    else:
        print("❌ No live API data available")
        return
    
    print("\n3. Simulating web API current interval logic...")
    # Simulate the exact logic from the web API
    current_time = datetime.now()
    start_date = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Find current interval
    current_interval_num = None
    for i in range(96):
        interval_start = start_date + timedelta(minutes=i * 15)
        interval_end = interval_start + timedelta(minutes=15)
        
        if interval_start <= current_time < interval_end:
            current_interval_num = i + 1
            print(f"   Current interval: {current_interval_num} ({interval_start.strftime('%H:%M')})")
            
            # Simulate the web API logic for current interval
            production = latest_data['totals']['production']
            consumption = latest_data['totals']['consumption']
            
            # This is the problematic logic from the web API
            if live_api_data and 'imports_total' in live_api_data and 'exports_total' in live_api_data:
                imports = live_api_data['imports_total']
                exports = live_api_data['exports_total']
                print(f"   🎯 Using live API data: Imports={imports} MW, Exports={exports} MW")
            elif 'imports_total' in latest_data and 'exports_total' in latest_data:
                imports = latest_data['imports_total']
                exports = latest_data['exports_total']
                print(f"   Using latest_data: Imports={imports} MW, Exports={exports} MW")
            else:
                # Fallback to totals from the data structure
                imports = latest_data['totals'].get('imports', 0.0)
                exports = latest_data['totals'].get('exports', 0.0)
                print(f"   Using totals fallback: Imports={imports} MW, Exports={exports} MW")
            
            print(f"   Final values: Production={production} MW, Consumption={consumption} MW")
            print(f"   Final values: Imports={imports} MW, Exports={exports} MW")
            break
    
    print("\n4. Checking import/export units mapping...")
    # Check the import/export units from the API client
    if hasattr(collector.client, 'import_export_units_mapping'):
        print(f"   Import/export units mapping has {len(collector.client.import_export_units_mapping)} entries")
        
        # Get the actual import/export units data
        if live_api_data and 'import_export_units' in live_api_data:
            units_data = live_api_data['import_export_units']
            print(f"   Import/export units data has {len(units_data)} entries")
            
            # Show the values for our 19 border points
            border_points = ['MUKA', 'ISPOZ', 'IS', 'UNGE', 'CIOA', 'GOTE', 'VULC', 'DOBR', 'VARN', 
                           'KOZL1', 'KOZL2', 'DJER', 'SIP_', 'PANCEVO21', 'PANCEVO22', 'KIKI', 'SAND', 'BEKE1', 'BEKE115']
            
            total_imports = 0
            total_exports = 0
            
            print(f"   Border point values:")
            for point in border_points:
                if point in units_data:
                    value = units_data[point]
                    print(f"     {point}: {value} MW")
                    if value > 0:
                        total_imports += value
                    elif value < 0:
                        total_exports += abs(value)
                else:
                    print(f"     {point}: NOT FOUND")
            
            print(f"   🎯 Calculated from border points: Imports={total_imports} MW, Exports={total_exports} MW")
        else:
            print("   ❌ No import/export units data in live API response")
    else:
        print("   ❌ No import/export units mapping in client")

if __name__ == "__main__":
    test_current_interval_logic()
