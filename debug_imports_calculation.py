#!/usr/bin/env python3
"""
Debug script to analyze the imports calculation and show individual border point contributions.
"""

import sys
import os
sys.path.append('src')

from api.transelectrica_client import TranselectricaClient
import json

def debug_imports_calculation():
    """Debug the imports calculation by showing individual contributions."""
    print("🔍 Debugging Imports Calculation")
    print("=" * 60)
    
    client = TranselectricaClient()
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch data")
        return False
    
    # Parse raw JSON
    raw_data = json.loads(data['raw_data'])
    feed_dict = client._to_dict(raw_data)
    
    # Get border flows calculation
    border_flows = client._calculate_border_flows(raw_data)
    
    print(f"📊 Current Dashboard Values:")
    print(f"   Imports: {data['imports_total']:,} MW")
    print(f"   Exports: {data['exports_total']:,} MW")
    print(f"   Net Flow: {data['imports_total'] - data['exports_total']:,} MW")
    print(f"   SOLD (from feed): {feed_dict.get('SOLD', 'N/A')} MW")
    
    print(f"\n🌐 Individual Border Point Analysis:")
    print(f"{'Border ID':<12} {'Value':<8} {'Type':<8} {'Contributes to'}")
    print("-" * 50)
    
    imports_sum = 0
    exports_sum = 0
    
    for border_id in client.LIVE_BORDER_IDS:
        value = feed_dict.get(border_id, 0)
        
        if value > 0:
            flow_type = "Import"
            contributes = "IMPORTS"
            imports_sum += value
        elif value < 0:
            flow_type = "Export"
            contributes = "EXPORTS"
            exports_sum += abs(value)
        else:
            flow_type = "Zero"
            contributes = "Neither"
        
        print(f"{border_id:<12} {value:<8} {flow_type:<8} {contributes}")
    
    print("-" * 50)
    print(f"{'TOTALS':<12} {'':<8} {'':<8}")
    print(f"{'Imports Sum':<12} {imports_sum:<8} {'':<8} = {imports_sum:,} MW")
    print(f"{'Exports Sum':<12} {exports_sum:<8} {'':<8} = {exports_sum:,} MW")
    print(f"{'Net Flow':<12} {imports_sum - exports_sum:<8} {'':<8} = {imports_sum - exports_sum:,} MW")
    
    # System balance check
    production = data['totals']['production']
    consumption = data['totals']['consumption']
    system_balance = production - consumption
    
    print(f"\n⚖️ System Balance Check:")
    print(f"   Production: {production:,.0f} MW")
    print(f"   Consumption: {consumption:,.0f} MW")
    print(f"   System Balance: {system_balance:,.0f} MW")
    print(f"   Expected Net Import Need: {-system_balance:,.0f} MW")
    print(f"   Calculated Net Flow: {imports_sum - exports_sum:,} MW")
    print(f"   SOLD Value: {feed_dict.get('SOLD', 'N/A')} MW")
    
    # Analysis
    print(f"\n🧮 Analysis:")
    if imports_sum > 2000:
        print(f"   ⚠️ Imports value ({imports_sum:,} MW) seems very high!")
        print(f"   🔍 Checking for unusually high individual values...")
        
        high_values = [(bid, feed_dict.get(bid, 0)) for bid in client.LIVE_BORDER_IDS 
                      if feed_dict.get(bid, 0) > 200]
        
        if high_values:
            print(f"   📈 Border points with values > 200 MW:")
            for bid, val in sorted(high_values, key=lambda x: abs(x[1]), reverse=True):
                print(f"      {bid}: {val} MW")
        
        # Check if some values might be generation instead of imports
        print(f"\n   💡 Possible issues:")
        print(f"      - Some IDs might represent generation units, not border flows")
        print(f"      - Values might need different sign convention")
        print(f"      - Some border points might be double-counted")
    
    expected_net = -system_balance
    actual_net = imports_sum - exports_sum
    difference = abs(expected_net - actual_net)
    
    if difference > 50:
        print(f"   ⚠️ Large difference between expected ({expected_net:.0f} MW) and calculated ({actual_net:.0f} MW) net flow")
    else:
        print(f"   ✅ Net flow calculation seems reasonable")
    
    return True

if __name__ == "__main__":
    debug_imports_calculation()
