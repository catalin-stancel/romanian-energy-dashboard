#!/usr/bin/env python3
"""
Debug script to investigate the SOLD value mismatch.
This script examines the raw feed to understand what might cause the difference.
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

def debug_sold_mismatch():
    """Debug the SOLD value mismatch by examining all feed values."""
    print("🔍 Debugging SOLD Value Mismatch")
    print("=" * 60)
    
    # Create client
    client = TranselectricaClient()
    
    # Fetch live data
    print("📡 Fetching live data...")
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch live data")
        return False
    
    # Parse raw JSON
    raw_data = json.loads(data['raw_data'])
    
    # Convert to dict for easier analysis
    feed_dict = client._to_dict(raw_data)
    
    # Calculate our border flows
    border_flows = client._calculate_border_flows(raw_data)
    
    print(f"📊 Current Analysis:")
    print(f"   Our Calculated Net: {border_flows['net']} MW")
    print(f"   SOLD in Feed: {border_flows['SOLD_in_feed']} MW")
    print(f"   Difference: {border_flows['net'] - border_flows['SOLD_in_feed']} MW")
    
    # Look for all keys that might be related to border flows or interconnections
    print(f"\n🔍 Searching for additional border/interconnection values...")
    
    # Known border points
    known_borders = set(client.LIVE_BORDER_IDS)
    
    # Find all keys that look like border points or interconnections
    potential_borders = []
    interconnection_keys = []
    other_flow_keys = []
    
    for key, value in feed_dict.items():
        if isinstance(value, (int, float)) and value != 0:
            # Skip known border points
            if key in known_borders:
                continue
            
            # Look for patterns that suggest border/interconnection points
            key_upper = key.upper()
            if any(pattern in key_upper for pattern in ['BORDER', 'INTER', 'CROSS', 'FLOW', 'EXCHANGE']):
                interconnection_keys.append((key, value))
            elif len(key) <= 10 and any(c.isalpha() for c in key) and any(c.isdigit() for c in key):
                # Might be a border point we don't know about
                potential_borders.append((key, value))
            elif 'SOLD' in key_upper or 'NET' in key_upper or 'BALANCE' in key_upper:
                other_flow_keys.append((key, value))
    
    if potential_borders:
        print(f"\n🌐 Potential Unknown Border Points:")
        total_unknown = 0
        for key, value in potential_borders:
            direction = "Import" if value > 0 else "Export" if value < 0 else "Balanced"
            print(f"   {key:>15}: {value:>6} MW ({direction})")
            total_unknown += value
        print(f"   {'TOTAL UNKNOWN':>15}: {total_unknown:>6} MW")
        
        # Check if adding unknown borders gets us closer to SOLD
        adjusted_net = border_flows['net'] + total_unknown
        print(f"\n🧮 If we include unknown borders:")
        print(f"   Adjusted Net: {adjusted_net} MW")
        print(f"   SOLD Value: {border_flows['SOLD_in_feed']} MW")
        print(f"   New Difference: {adjusted_net - border_flows['SOLD_in_feed']} MW")
    
    if interconnection_keys:
        print(f"\n🔗 Interconnection-related Keys:")
        for key, value in interconnection_keys:
            print(f"   {key:>15}: {value:>6} MW")
    
    if other_flow_keys:
        print(f"\n⚖️ Other Flow-related Keys:")
        for key, value in other_flow_keys:
            print(f"   {key:>15}: {value:>6} MW")
    
    # Show all non-zero numeric values for complete analysis
    print(f"\n📋 All Non-Zero Numeric Values in Feed:")
    all_numeric = [(k, v) for k, v in feed_dict.items() if isinstance(v, (int, float)) and v != 0]
    all_numeric.sort(key=lambda x: abs(x[1]), reverse=True)  # Sort by absolute value, largest first
    
    for key, value in all_numeric[:30]:  # Show top 30 values
        if key in known_borders:
            marker = "🌐"  # Known border
        elif any(pattern in key.upper() for pattern in ['PROD', 'CONS', 'NUCL', 'CARB', 'GAZE', 'EOLIAN', 'APE', 'FOTO']):
            marker = "⚡"  # Generation/consumption
        elif 'SOLD' in key.upper():
            marker = "💰"  # SOLD related
        else:
            marker = "❓"  # Unknown
        
        print(f"   {marker} {key:>15}: {value:>8} MW")
    
    return True

def main():
    """Main debug function."""
    try:
        success = debug_sold_mismatch()
        if success:
            print(f"\n🎉 Debug analysis completed!")
            return 0
        else:
            print(f"\n💥 Debug analysis failed!")
            return 1
    except Exception as e:
        logger.error(f"Debug failed with exception: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    exit(main())
