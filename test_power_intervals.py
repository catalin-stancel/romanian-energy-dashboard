#!/usr/bin/env python3
"""
Test the power generation intervals API endpoint that the dashboard uses.
"""

import requests
import json

def test_power_intervals():
    try:
        # Test the power generation intervals endpoint that the dashboard uses
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        
        if response.status_code == 200:
            data = response.json()
            print('✅ Power generation intervals API is working')
            print(f'📊 Date: {data["date"]}')
            print(f'📈 Total intervals: {data["total_intervals"]}')
            print(f'🔢 Historical intervals: {data["historical_intervals"]}')
            print(f'⏰ Current interval: {data["current_interval"]}')
            
            # Check if we have data for current interval
            current_data = None
            for interval in data['intervals']:
                if interval['is_current'] and interval['has_data']:
                    current_data = interval
                    break
            
            if current_data:
                print(f'⚡ Current interval data:')
                print(f'   Production: {current_data["production"]}MW')
                print(f'   Consumption: {current_data["consumption"]}MW')
                print(f'   Net Balance: {current_data["net_balance"]}MW')
                print(f'   Status: {current_data["status"]}')
                print('✅ Dashboard should be able to load this data!')
            else:
                print('⚠️ No data available for current interval')
                print('❌ This is why the dashboard shows "failed to load power generation data"')
                
        else:
            print(f'❌ API Error: {response.status_code}')
            print(response.text)
            
    except Exception as e:
        print(f'❌ Connection Error: {e}')

if __name__ == "__main__":
    test_power_intervals()
