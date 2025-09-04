#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.api.transelectrica_client import TranselectricaClient
import json

def debug_raw_api_response():
    """Debug the raw API response to see what data is actually available."""
    print("🔍 Debugging Raw API Response")
    print("=" * 50)
    
    # Create client
    client = TranselectricaClient()
    
    # Get raw API response
    data = client.fetch_power_data()
    
    if data:
        print(f"✅ API response received")
        print(f"   Timestamp: {data['timestamp']}")
        print(f"   Production: {data['totals']['production']} MW")
        print(f"   Consumption: {data['totals']['consumption']} MW")
        print(f"   Imports Total: {data['imports_total']} MW")
        print(f"   Exports Total: {data['exports_total']} MW")
        
        print("\n🔍 Import/Export Units Data:")
        for unit, value in data['import_export_units'].items():
            print(f"   {unit}: {value} MW")
        
        print("\n🔍 Raw JSON Data (first 2000 chars):")
        raw_data = json.loads(data['raw_data'])
        print(json.dumps(raw_data, indent=2)[:2000])
        
        print("\n🔍 Looking for border point keys in raw data:")
        border_points = ['unit_muka', 'unit_ispoz', 'unit_is', 'unit_unge', 'unit_cioa', 'unit_gote', 
                        'unit_vulc', 'unit_dobr', 'unit_varn', 'unit_kozl1', 'unit_kozl2', 'unit_djer', 
                        'unit_sip', 'unit_pancevo21', 'unit_pancevo22', 'unit_kiki', 'unit_sand', 
                        'unit_beke1', 'unit_beke115']
        
        found_keys = []
        for item in raw_data:
            for key in item.keys():
                if key.lower() in [bp.lower() for bp in border_points]:
                    found_keys.append((key, item[key]))
        
        if found_keys:
            print("   Found border point keys in raw data:")
            for key, value in found_keys:
                print(f"     {key}: {value}")
        else:
            print("   ❌ No border point keys found in raw data")
            
        print("\n🔍 All unique keys in raw data:")
        all_keys = set()
        for item in raw_data:
            all_keys.update(item.keys())
        
        sorted_keys = sorted(all_keys)
        for key in sorted_keys:
            print(f"   {key}")
    
    else:
        print("❌ No API response received")

if __name__ == "__main__":
    debug_raw_api_response()
