#!/usr/bin/env python3
"""
Script to identify which border point IDs should be excluded to reduce imports by ~140 MW.
"""

import sys
import os
sys.path.append('src')

from api.transelectrica_client import TranselectricaClient
import json

def analyze_border_points_to_exclude():
    """Analyze which border points might need to be excluded."""
    print("🔍 Analyzing Border Points to Exclude (~140 MW reduction needed)")
    print("=" * 70)
    
    client = TranselectricaClient()
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch data")
        return False
    
    # Parse raw JSON
    raw_data = json.loads(data['raw_data'])
    feed_dict = client._to_dict(raw_data)
    
    print(f"📊 Current Status:")
    print(f"   Current Imports: {data['imports_total']:,} MW")
    print(f"   Target Imports: ~{data['imports_total'] - 140:,} MW")
    print(f"   Need to reduce by: ~140 MW")
    print(f"   SOLD Value: {feed_dict.get('SOLD', 'N/A')} MW")
    
    print(f"\n🌐 Border Points Contributing to Imports (positive values):")
    print(f"{'Border ID':<12} {'Value':<8} {'Cumulative':<12} {'Notes'}")
    print("-" * 60)
    
    import_contributors = []
    for border_id in client.LIVE_BORDER_IDS:
        value = feed_dict.get(border_id, 0)
        if value > 0:
            import_contributors.append((border_id, value))
    
    # Sort by value (highest first)
    import_contributors.sort(key=lambda x: x[1], reverse=True)
    
    cumulative = 0
    for border_id, value in import_contributors:
        cumulative += value
        notes = ""
        
        # Add notes for suspicious values
        if value > 300:
            notes = "⚠️ Very high - check if this is cross-border"
        elif border_id in ['KOZL2']:
            notes = "🔍 Check if this represents actual import"
        elif border_id in ['MUKA']:
            notes = "✅ Likely legitimate cross-border"
        
        print(f"{border_id:<12} {value:<8} {cumulative:<12} {notes}")
    
    print("-" * 60)
    print(f"{'TOTAL':<12} {cumulative:<8}")
    
    # Suggest combinations that would reduce by ~140 MW
    print(f"\n💡 Possible Exclusions to Reduce by ~140 MW:")
    
    # Look for combinations that sum to around 140
    target_reduction = 140
    tolerance = 20
    
    # Single exclusions
    print(f"\n   Single Exclusions:")
    for border_id, value in import_contributors:
        if abs(value - target_reduction) <= tolerance:
            new_total = cumulative - value
            print(f"   - Exclude {border_id} ({value} MW) → New total: {new_total} MW")
    
    # Two-item combinations
    print(f"\n   Two-Item Combinations:")
    for i, (id1, val1) in enumerate(import_contributors):
        for j, (id2, val2) in enumerate(import_contributors[i+1:], i+1):
            combined = val1 + val2
            if abs(combined - target_reduction) <= tolerance:
                new_total = cumulative - combined
                print(f"   - Exclude {id1} ({val1} MW) + {id2} ({val2} MW) = {combined} MW → New total: {new_total} MW")
    
    # Based on the network diagram analysis
    print(f"\n🗺️ Network Diagram Analysis:")
    print(f"   From the Transelectrica network diagram, these might not be cross-border:")
    print(f"   - Some IDs might represent internal interconnections")
    print(f"   - Some might be generation units rather than border flows")
    print(f"   - KOZL2 (356 MW) seems suspiciously high for a single border point")
    
    return True

if __name__ == "__main__":
    analyze_border_points_to_exclude()
