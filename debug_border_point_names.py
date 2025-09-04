#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.power_generation_collector import PowerGenerationCollector

def debug_border_point_names():
    """Debug what border point names are actually available in the API response."""
    print("🔍 Debugging Border Point Names")
    print("=" * 50)
    
    # Create fresh collector
    collector = PowerGenerationCollector()
    
    # Get fresh live API data
    live_api_data = collector.client.fetch_power_data()
    
    if live_api_data and 'import_export_units' in live_api_data:
        units_data = live_api_data['import_export_units']
        print(f"✅ Found {len(units_data)} import/export units in API response:")
        print()
        
        # Show all available border point names
        for name, value in units_data.items():
            print(f"   '{name}': {value} MW")
        
        print()
        print("🎯 Expected border points from user specification:")
        expected_points = ['MUKA', 'ISPOZ', 'IS', 'UNGE', 'CIOA', 'GOTE', 'VULC', 'DOBR', 'VARN', 
                          'KOZL1', 'KOZL2', 'DJER', 'SIP_', 'PANCEVO21', 'PANCEVO22', 'KIKI', 'SAND', 'BEKE1', 'BEKE115']
        
        for point in expected_points:
            if point in units_data:
                print(f"   ✅ {point}: {units_data[point]} MW")
            else:
                print(f"   ❌ {point}: NOT FOUND")
        
        print()
        print("🔍 Looking for similar names (case-insensitive partial matches):")
        for expected in expected_points:
            matches = []
            for actual in units_data.keys():
                if expected.lower() in actual.lower() or actual.lower() in expected.lower():
                    matches.append(actual)
            
            if matches:
                print(f"   {expected} -> Possible matches: {matches}")
            else:
                print(f"   {expected} -> No matches found")
    
    else:
        print("❌ No import/export units data available")
    
    print()
    print("🔍 Checking TranselectricaClient mapping:")
    if hasattr(collector.client, 'import_export_units_mapping'):
        mapping = collector.client.import_export_units_mapping
        print(f"   Mapping has {len(mapping)} entries:")
        for key, value in mapping.items():
            print(f"     '{key}': '{value}'")
    else:
        print("   ❌ No import_export_units_mapping found")

if __name__ == "__main__":
    debug_border_point_names()
