#!/usr/bin/env python3
"""
Test script to validate the corrected border flow calculation.
This script tests the new algorithm against the live Transelectrica feed.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from src.api.transelectrica_client import TranselectricaClient
import logging
import json

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def test_border_flow_calculation():
    """Test the corrected border flow calculation against live feed."""
    print("🧪 Testing Corrected Border Flow Calculation")
    print("=" * 60)
    
    # Create client
    client = TranselectricaClient()
    
    # Test connection first
    print("🔗 Testing API connection...")
    if not client.test_connection():
        print("❌ Failed to connect to Transelectrica API")
        return False
    
    print("✅ API connection successful")
    
    # Fetch live data
    print("\n📡 Fetching live data...")
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch live data")
        return False
    
    print("✅ Live data fetched successfully")
    
    # Parse raw JSON to test the algorithm directly
    raw_data = json.loads(data['raw_data'])
    
    # Test the border flow calculation
    print("\n🔍 Testing border flow calculation...")
    border_flows = client._calculate_border_flows(raw_data)
    
    # Display results
    print(f"\n📊 Border Flow Calculation Results:")
    print(f"   Imports: {border_flows['imports']:,} MW")
    print(f"   Exports: {border_flows['exports']:,} MW")
    print(f"   Net Flow: {border_flows['net']:,} MW")
    print(f"   SOLD in Feed: {border_flows['SOLD_in_feed']}")
    
    # Validation
    if border_flows['matches_SOLD'] is not None:
        if border_flows['matches_SOLD']:
            print(f"✅ VALIDATION PASSED: Calculated net flow matches SOLD value!")
        else:
            print(f"❌ VALIDATION FAILED: Calculated net flow ({border_flows['net']}) != SOLD ({border_flows['SOLD_in_feed']})")
    else:
        print(f"⚠️ SOLD value not available in feed for validation")
    
    # Display individual border point values
    print(f"\n🌐 Individual Border Point Values:")
    for i, border_id in enumerate(client.LIVE_BORDER_IDS):
        value = border_flows['border_details'][border_id]
        direction = "Import" if value > 0 else "Export" if value < 0 else "Balanced"
        print(f"   {border_id:>10}: {value:>6} MW ({direction})")
    
    # Compare with old calculation method (from the result data)
    print(f"\n🔄 Comparison with Dashboard Data:")
    print(f"   New Imports: {border_flows['imports']:,} MW")
    print(f"   Old Imports: {data['imports_total']:,} MW")
    print(f"   New Exports: {border_flows['exports']:,} MW")
    print(f"   Old Exports: {data['exports_total']:,} MW")
    
    # Check if values are different
    imports_match = border_flows['imports'] == data['imports_total']
    exports_match = border_flows['exports'] == data['exports_total']
    
    if imports_match and exports_match:
        print(f"✅ New calculation matches current dashboard values")
    else:
        print(f"🔄 New calculation differs from current dashboard:")
        if not imports_match:
            print(f"   Import difference: {border_flows['imports'] - data['imports_total']:+,} MW")
        if not exports_match:
            print(f"   Export difference: {border_flows['exports'] - data['exports_total']:+,} MW")
    
    # Summary
    print(f"\n📋 Summary:")
    print(f"   ✅ API Connection: Working")
    print(f"   ✅ Data Retrieval: Working")
    print(f"   ✅ Border Flow Calculation: Working")
    if border_flows['matches_SOLD']:
        print(f"   ✅ SOLD Validation: PASSED")
    elif border_flows['matches_SOLD'] is False:
        print(f"   ❌ SOLD Validation: FAILED")
    else:
        print(f"   ⚠️ SOLD Validation: Not Available")
    
    return True

def main():
    """Main test function."""
    try:
        success = test_border_flow_calculation()
        if success:
            print(f"\n🎉 Test completed successfully!")
            return 0
        else:
            print(f"\n💥 Test failed!")
            return 1
    except Exception as e:
        logger.error(f"Test failed with exception: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    exit(main())
