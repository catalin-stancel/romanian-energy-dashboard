import requests
import json
from datetime import datetime

try:
    # Test the power generation intervals endpoint
    response = requests.get('http://localhost:8000/api/power-generation-intervals')
    if response.status_code == 200:
        data = response.json()
        print('✅ API endpoint working!')
        print(f'📊 Total intervals: {data["total_intervals"]}')
        print(f'📈 Historical intervals with data: {data["historical_intervals"]}')
        print(f'🕐 Current interval: {data["current_interval"]}')
        
        # Show first few intervals with data
        intervals_with_data = [i for i in data['intervals'] if i['has_data']]
        print(f'\n🔍 Found {len(intervals_with_data)} intervals with actual data:')
        for interval in intervals_with_data[:3]:  # Show first 3
            print(f'  {interval["time"]}: {interval["production"]}MW production, {interval["consumption"]}MW consumption, Status: {interval["status"]}')
            
        # Show current interval specifically
        current_intervals = [i for i in data['intervals'] if i['is_current']]
        if current_intervals:
            current = current_intervals[0]
            print(f'\n⏰ Current interval ({current["time"]}):')
            print(f'  Production: {current["production"]}MW')
            print(f'  Consumption: {current["consumption"]}MW')
            print(f'  Imports: {current["imports"]}MW')
            print(f'  Exports: {current["exports"]}MW')
            print(f'  Net Balance: {current["net_balance"]}MW')
            print(f'  Status: {current["status"]}')
    else:
        print(f'❌ API error: {response.status_code}')
        print(response.text)
except Exception as e:
    print(f'❌ Connection error: {e}')
    print('Make sure the server is running at http://localhost:8000')
