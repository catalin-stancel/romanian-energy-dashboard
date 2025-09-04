#!/usr/bin/env python3
"""
Test the debug power generation endpoint.
"""

import requests

def test_debug_endpoint():
    try:
        response = requests.get('http://localhost:8000/api/debug-power-generation')
        if response.status_code == 200:
            data = response.json()
            print('✅ Debug endpoint works!')
            if 'latest_data' in data:
                print(f'⚡ Production: {data["latest_data"]["production"]}MW')
                print(f'🏠 Consumption: {data["latest_data"]["consumption"]}MW')
                print(f'⚖️ Net Balance: {data["latest_data"]["net_balance"]}MW')
            print(f'📝 Message: {data["message"]}')
        else:
            print(f'❌ Debug endpoint error: {response.status_code}')
            print(response.text)
    except Exception as e:
        print(f'❌ Connection error: {e}')

if __name__ == "__main__":
    test_debug_endpoint()
