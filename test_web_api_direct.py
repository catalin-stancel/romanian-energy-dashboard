#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import requests
import json

def test_web_api_direct():
    """Test the web API endpoint directly to see current values."""
    print("🔍 Testing Web API Endpoint Directly")
    print("=" * 50)
    
    try:
        # Test the power generation endpoint
        url = "http://localhost:8000/api/power-generation-intervals"
        print(f"📡 Making request to: {url}")
        
        response = requests.get(url, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            print("✅ Response received successfully")
            
            # Find current interval
            current_interval = None
            for interval in data['intervals']:
                if interval['is_current']:
                    current_interval = interval
                    break
            
            if current_interval:
                print(f"\n🎯 Current Interval Data:")
                print(f"   Time: {current_interval['time']}")
                print(f"   Production: {current_interval['production']} MW")
                print(f"   Consumption: {current_interval['consumption']} MW")
                print(f"   Imports: {current_interval['imports']} MW")
                print(f"   Exports: {current_interval['exports']} MW")
                print(f"   Net Balance: {current_interval['net_balance']} MW")
                print(f"   Status: {current_interval['status']}")
                
                # Check if this matches our expected values
                if current_interval['imports'] > 1000:
                    print(f"   ✅ SUCCESS: Imports are correctly showing high values!")
                else:
                    print(f"   ❌ ISSUE: Imports are still showing low values (expected >1000 MW)")
            else:
                print("❌ No current interval found")
        else:
            print(f"❌ Request failed with status code: {response.status_code}")
            print(f"   Response: {response.text}")
            
    except requests.exceptions.ConnectionError:
        print("❌ Connection failed - is the web server running?")
        print("   Try running: python src/web/app.py")
    except Exception as e:
        print(f"❌ Error: {str(e)}")

if __name__ == "__main__":
    test_web_api_direct()
