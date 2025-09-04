#!/usr/bin/env python3
"""
Test script to verify the current border points configuration
and ensure BEKE115 has been properly removed.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.api.transelectrica_client import TranselectricaClient

def test_border_points_config():
    """Test the current border points configuration."""
    print("🔍 TESTING BORDER POINTS CONFIGURATION")
    print("=" * 60)
    
    client = TranselectricaClient()
    
    # Get the configured border points
    border_points = list(client.import_export_units_mapping.keys())
    
    print(f"📊 Total configured border points: {len(border_points)}")
    print("\n🌍 Configured Border Points:")
    
    expected_points = [
        'unit_muka', 'unit_ispoz', 'unit_is', 'unit_unge', 'unit_cioa', 
        'unit_gote', 'unit_vulc', 'unit_dobr', 'unit_varn', 'unit_kozl1', 
        'unit_kozl2', 'unit_djer', 'unit_sip', 'unit_pancevo21', 'unit_pancevo22', 
        'unit_kiki', 'unit_sand', 'unit_beke1'
    ]
    
    for i, point in enumerate(border_points, 1):
        status = "✅" if point in expected_points else "❌"
        print(f"  {i:2d}. {point} {status}")
    
    # Check for BEKE115
    if 'unit_beke115' in border_points:
        print(f"\n❌ ERROR: BEKE115 is still configured (should be removed)")
        return False
    else:
        print(f"\n✅ SUCCESS: BEKE115 has been properly removed")
    
    # Check count
    if len(border_points) == 18:
        print(f"✅ SUCCESS: Correct number of border points (18)")
        return True
    else:
        print(f"❌ ERROR: Expected 18 border points, found {len(border_points)}")
        return False

def test_api_data():
    """Test actual API data to see current values."""
    print("\n" + "=" * 60)
    print("🔍 TESTING LIVE API DATA")
    print("=" * 60)
    
    client = TranselectricaClient()
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch API data")
        return False
    
    print(f"✅ API data fetched successfully")
    print(f"📊 Total Production: {data['totals']['production']:.1f} MW")
    print(f"📊 Total Consumption: {data['totals']['consumption']:.1f} MW")
    print(f"📊 Imports Total: {data['imports_total']:.1f} MW")
    print(f"📊 Exports Total: {data['exports_total']:.1f} MW")
    
    print(f"\n🌍 Active Border Points (non-zero values):")
    active_count = 0
    for unit, value in data['import_export_units'].items():
        if abs(value) > 0.1:  # Only show non-zero values
            direction = "Import" if value > 0 else "Export"
            print(f"  {unit.replace('unit_', '').upper()}: {abs(value):.1f} MW ({direction})")
            active_count += 1
    
    print(f"\n📈 Summary: {active_count} active border points out of {len(data['import_export_units'])} configured")
    
    # Check if BEKE115 appears in the data
    if 'unit_beke115' in data['import_export_units']:
        print(f"❌ ERROR: BEKE115 data found in API response")
        return False
    else:
        print(f"✅ SUCCESS: No BEKE115 data in API response")
        return True

def main():
    """Run all border points configuration tests."""
    print("🚀 BORDER POINTS CONFIGURATION TEST")
    print(f"⏰ Test time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Test 1: Configuration
    config_result = test_border_points_config()
    
    # Test 2: API Data
    api_result = test_api_data()
    
    # Summary
    print("\n" + "=" * 60)
    print("📋 TEST SUMMARY")
    print("=" * 60)
    print(f"✅ Configuration Test: {'PASS' if config_result else 'FAIL'}")
    print(f"✅ API Data Test: {'PASS' if api_result else 'FAIL'}")
    
    if config_result and api_result:
        print("\n🎉 ALL TESTS PASSED!")
        print("✅ Border points configuration is correct (18 points)")
        print("✅ BEKE115 has been properly removed")
        print("✅ API is returning data for correct border points")
    else:
        print("\n❌ SOME TESTS FAILED!")
        print("🔧 Border points configuration needs attention")

if __name__ == "__main__":
    from datetime import datetime
    main()
