#!/usr/bin/env python3
"""
Analyze system balance to understand import/export requirements.
"""

import sys
import os
sys.path.append('src')

from api.transelectrica_client import TranselectricaClient
import json

def analyze_system_balance():
    """Analyze the system balance and import/export requirements."""
    print("🔍 Analyzing System Balance")
    print("=" * 60)
    
    client = TranselectricaClient()
    data = client.fetch_power_data()
    
    if not data:
        print("❌ Failed to fetch data")
        return False
    
    raw_data = json.loads(data['raw_data'])
    feed_dict = client._to_dict(raw_data)
    
    # Current system status
    production = data['totals']['production']
    consumption = data['totals']['consumption']
    system_balance = production - consumption
    sold_value = feed_dict.get('SOLD', 0)
    
    print(f"📊 Current System Status:")
    print(f"   Production: {production:,.0f} MW")
    print(f"   Consumption: {consumption:,.0f} MW")
    print(f"   System Balance: {system_balance:,.0f} MW")
    print(f"   SOLD (from feed): {sold_value} MW")
    
    # Current border flow calculation
    border_imports = data['imports_total']
    border_exports = data['exports_total']
    border_net = border_imports - border_exports
    
    print(f"\n🌐 Current Border Flow Calculation:")
    print(f"   Border Imports: {border_imports:,.0f} MW")
    print(f"   Border Exports: {border_exports:,.0f} MW")
    print(f"   Border Net Flow: {border_net:,.0f} MW")
    
    # Analysis
    print(f"\n🧮 Analysis:")
    print(f"   System needs: {-system_balance:,.0f} MW {'imports' if system_balance < 0 else 'exports'}")
    print(f"   SOLD indicates: {sold_value} MW net flow")
    print(f"   Border calculation shows: {border_net:,.0f} MW net flow")
    
    # The issue: system balance should be close to 0
    # If production < consumption, we need imports
    # If production > consumption, we export
    # The total should balance: production + imports = consumption + exports
    
    print(f"\n⚖️ Balance Check:")
    print(f"   Production + Imports: {production + border_imports:,.0f} MW")
    print(f"   Consumption + Exports: {consumption + border_exports:,.0f} MW")
    print(f"   Difference: {(production + border_imports) - (consumption + border_exports):,.0f} MW")
    
    # Correct approach: use SOLD value or system balance
    if abs(sold_value) < abs(border_net):
        print(f"\n💡 Recommendation:")
        print(f"   Use SOLD value ({sold_value} MW) as the net flow")
        print(f"   This would give a more balanced system")
        
        # Calculate what imports/exports should be based on SOLD
        if sold_value > 0:  # Net import
            suggested_imports = sold_value
            suggested_exports = 0
        else:  # Net export
            suggested_imports = 0
            suggested_exports = abs(sold_value)
            
        print(f"   Suggested Imports: {suggested_imports} MW")
        print(f"   Suggested Exports: {suggested_exports} MW")
        print(f"   This would make total balance: {(production + suggested_imports) - (consumption + suggested_exports):,.0f} MW")
    
    return True

if __name__ == "__main__":
    analyze_system_balance()
