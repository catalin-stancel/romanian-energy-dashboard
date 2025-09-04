#!/usr/bin/env python3
"""
Test the web API to verify data refresh is working end-to-end.
"""

import requests
import json

def test_web_api():
    try:
        # Test the power generation API endpoint
        response = requests.get('http://localhost:8000/api/power-generation')
        
        if response.status_code == 200:
            data = response.json()
            print('🌐 Web API Response:')
            print(json.dumps(data, indent=2))
            
            # Check if we have the expected data structure
            if 'data' in data and data['data'] and 'totals' in data['data']:
                power_data = data['data']
                print(f'⚡ Production: {power_data["totals"]["production"]}MW')
                print(f'🏠 Consumption: {power_data["totals"]["consumption"]}MW') 
                print(f'⚖️ Net Balance: {power_data["totals"]["net_balance"]}MW')
                print(f'🕐 Timestamp: {power_data["timestamp"]}')
                
                # Check if we're getting fresh data (not the old -634 value)
                net_balance = power_data["totals"]["net_balance"]
                if net_balance != -634:
                    print('✅ SUCCESS: Fresh data is being served by the web API!')
                    print(f'   Net balance is {net_balance}MW (not the old -634MW)')
                else:
                    print('❌ ISSUE: Still getting stale data (-634MW)')
            else:
                print('⚠️ Unexpected API response structure')
                
        else:
            print(f'❌ API Error: {response.status_code}')
            print(response.text)
            
    except Exception as e:
        print(f'❌ Connection Error: {e}')
        print('Make sure the web server is running on http://localhost:8000')

if __name__ == "__main__":
    test_web_api()
