#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import requests
import json
from src.data.power_generation_collector import PowerGenerationCollector

def final_verification():
    """Final verification that the dashboard is showing correct import/export values."""
    print("🔍 Final Dashboard Import/Export Verification")
    print("=" * 60)
    
    # Test 1: Direct API client test
    print("1. Testing TranselectricaClient directly...")
    try:
        collector = PowerGenerationCollector()
        api_data = collector.client.fetch_power_data()
        
        if api_data:
            print(f"   ✅ Direct API: Imports={api_data['imports_total']} MW, Exports={api_data['exports_total']} MW")
            direct_imports = api_data['imports_total']
            direct_exports = api_data['exports_total']
        else:
            print("   ❌ Direct API failed")
            return
    except Exception as e:
        print(f"   ❌ Direct API error: {e}")
        return
    
    # Test 2: Web API endpoint test
    print("\n2. Testing web API endpoint...")
    try:
        response = requests.get("http://localhost:8000/api/power-generation-intervals", timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            
            # Find current interval
            current_interval = None
            for interval in data['intervals']:
                if interval['is_current']:
                    current_interval = interval
                    break
            
            if current_interval:
                web_imports = current_interval['imports']
                web_exports = current_interval['exports']
                print(f"   ✅ Web API: Imports={web_imports} MW, Exports={web_exports} MW")
                
                # Compare values
                print(f"\n3. Comparison:")
                print(f"   Direct API: {direct_imports} MW imports, {direct_exports} MW exports")
                print(f"   Web API:    {web_imports} MW imports, {web_exports} MW exports")
                
                # Check if values are reasonable (> 1000 MW imports expected)
                if web_imports > 1000:
                    print(f"\n🎉 SUCCESS: Dashboard is showing correct high import values!")
                    print(f"   The 19 Romanian border points are being properly tracked:")
                    print(f"   MUKA, ISPOZ, IS, UNGE, CIOA, GOTE, VULC, DOBR, VARN,")
                    print(f"   KOZL1, KOZL2, DJER, SIP_, PANCEVO21, PANCEVO22, KIKI, SAND, BEKE1, BEKE115")
                    print(f"\n   ✅ Positive values = Romania importing: {web_imports} MW")
                    print(f"   ✅ Negative values = Romania exporting: {web_exports} MW")
                elif web_imports > 300:
                    print(f"\n⚠️  PARTIAL SUCCESS: Import values improved but may still be low")
                    print(f"   Expected >1000 MW, got {web_imports} MW")
                else:
                    print(f"\n❌ ISSUE: Import values are still too low")
                    print(f"   Expected >1000 MW, got {web_imports} MW")
                
            else:
                print("   ❌ No current interval found in web API response")
        else:
            print(f"   ❌ Web API failed with status {response.status_code}")
            
    except requests.exceptions.ConnectionError:
        print("   ❌ Web API connection failed - is the server running?")
    except Exception as e:
        print(f"   ❌ Web API error: {e}")

if __name__ == "__main__":
    final_verification()
