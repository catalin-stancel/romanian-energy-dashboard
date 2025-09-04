#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.api.transelectrica_client import TranselectricaClient
import json
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def check_raw_feed():
    """Check the complete raw feed data to identify all units."""
    
    print("🔍 Checking Complete Raw Feed Data...")
    
    # Fetch current data from Transelectrica API
    client = TranselectricaClient()
    current_data = client.fetch_power_data()
    
    if not current_data:
        print("❌ Failed to fetch current data")
        return
    
    print(f"✅ Successfully fetched data at {current_data['timestamp']}")
    
    # Parse the raw JSON data
    raw_data = json.loads(current_data['raw_data'])
    
    print(f"\n📊 Complete Raw Feed Data ({len(raw_data)} items):")
    print("=" * 80)
    
    # Group data by type
    numeric_values = {}
    text_values = {}
    zero_values = {}
    
    for item in raw_data:
        for key, value in item.items():
            try:
                # Try to convert to float
                float_val = float(value)
                if float_val == 0:
                    zero_values[key] = float_val
                else:
                    numeric_values[key] = float_val
            except (ValueError, TypeError):
                # It's a text value
                text_values[key] = value
    
    print(f"\n🔢 Non-zero Numeric Values ({len(numeric_values)} items):")
    for key, value in sorted(numeric_values.items(), key=lambda x: abs(x[1]), reverse=True):
        print(f"  {key}: {value}")
    
    print(f"\n0️⃣ Zero Values ({len(zero_values)} items):")
    zero_keys = sorted(zero_values.keys())
    for i in range(0, len(zero_keys), 5):  # Print 5 per line
        line_keys = zero_keys[i:i+5]
        print(f"  {', '.join(line_keys)}")
    
    print(f"\n📝 Text Values ({len(text_values)} items):")
    for key, value in text_values.items():
        print(f"  {key}: {value}")
    
    # Check our current mapping coverage
    print(f"\n🎯 Current Import/Export Units Mapping Coverage:")
    mapped_units = [
        'MUKA', 'ISPOZ', 'IS', 'UNGE', 'CIOA', 'GOTE', 'VULC', 'DOBR', 'VARN',
        'KOZL1', 'KOZL2', 'DJER', 'SIP_', 'PANCEVO21', 'PANCEVO22', 'KIKI', 'SAND', 'BEKE1', 'BEKE115'
    ]
    
    found_units = []
    missing_units = []
    
    for unit in mapped_units:
        if unit in numeric_values or unit in zero_values:
            found_units.append(unit)
            if unit in numeric_values:
                print(f"  ✅ {unit}: {numeric_values[unit]} MW")
            else:
                print(f"  ⚪ {unit}: 0 MW")
        else:
            missing_units.append(unit)
            print(f"  ❌ {unit}: NOT FOUND in feed")
    
    # Look for potential additional import/export units
    print(f"\n🔍 Potential Additional Import/Export Units:")
    potential_units = []
    
    for key, value in numeric_values.items():
        if key not in mapped_units and key not in ['PROD', 'CONS', 'CONS15']:
            # Skip obvious generation units
            generation_keywords = ['NUCL', 'CARB', 'GAZE', 'EOLIAN', 'APE', 'FOTO', 'CHEA', 'CHEF', 'SOLD', 'PARO', 'BMASA']
            is_generation = any(keyword in key for keyword in generation_keywords)
            
            if not is_generation:
                potential_units.append((key, value))
    
    if potential_units:
        potential_units.sort(key=lambda x: abs(x[1]), reverse=True)
        for key, value in potential_units:
            print(f"  🤔 {key}: {value} MW")
    else:
        print("  ✅ No additional potential units found")
    
    # Summary
    print(f"\n📈 Summary:")
    print(f"  Current imports total: {current_data['imports_total']} MW")
    print(f"  Current exports total: {current_data['exports_total']} MW")
    print(f"  Total absolute: {current_data['imports_total'] + current_data['exports_total']} MW")
    print(f"  Mapped units found: {len(found_units)}/{len(mapped_units)}")
    print(f"  Potential additional units: {len(potential_units)}")
    
    print("\n✅ Raw feed analysis complete!")

if __name__ == "__main__":
    check_raw_feed()
