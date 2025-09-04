#!/usr/bin/env python3
"""
Test script to verify dashboard displays correct import/export values.
"""

import sys
import os
sys.path.append('src')

from api.transelectrica_client import TranselectricaClient

def test_dashboard_values():
    """Test the dashboard import/export values."""
    print("🧪 Testing Dashboard Import/Export Values")
    print("=" * 60)
    
    client = TranselectricaClient()
    data = client.fetch_power_data()
    
    if data:
        print(f"📊 Dashboard Import/Export Values:")
        print(f"   Imports: {data['imports_total']:,} MW")
        print(f"   Exports: {data['exports_total']:,} MW")
        print(f"   Net Flow: {data['imports_total'] - data['exports_total']:,} MW")
        print(f"   Production: {data['totals']['production']:,} MW")
        print(f"   Consumption: {data['totals']['consumption']:,} MW")
        print(f"   System Balance: {data['totals']['production'] - data['totals']['consumption']:,} MW")
        
        # Check if values are reasonable (> 0 and < 10000 MW)
        imports_ok = 0 <= data['imports_total'] <= 10000
        exports_ok = 0 <= data['exports_total'] <= 10000
        
        print(f"\n✅ Validation:")
        print(f"   Imports in range [0-10000]: {'✅' if imports_ok else '❌'}")
        print(f"   Exports in range [0-10000]: {'✅' if exports_ok else '❌'}")
        print(f"   Values are realistic: {'✅' if imports_ok and exports_ok else '❌'}")
        
        return True
    else:
        print("❌ Failed to fetch data")
        return False

if __name__ == "__main__":
    test_dashboard_values()
