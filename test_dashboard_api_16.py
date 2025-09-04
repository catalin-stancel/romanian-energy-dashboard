import requests
import json

# Test the dashboard API
try:
    response = requests.get('http://localhost:5000/api/intervals')
    if response.status_code == 200:
        data = response.json()
        print('=== Dashboard API Response ===')
        
        # Look for 16:00 interval
        for interval in data:
            if '16:00' in interval['timestamp']:
                print('16:00 Interval from API:')
                print(f'  timestamp: {interval["timestamp"]}')
                print(f'  total_balance: {interval.get("total_balance", "N/A")} MW')
                print(f'  imports: {interval.get("imports", "N/A")} MW')
                print(f'  exports: {interval.get("exports", "N/A")} MW')
                print(f'  production: {interval.get("production", "N/A")} MW')
                print(f'  consumption: {interval.get("consumption", "N/A")} MW')
                
                # Calculate system balance
                if all(key in interval for key in ['production', 'imports', 'consumption', 'exports']):
                    calc_balance = (interval['production'] + interval['imports']) - (interval['consumption'] + interval['exports'])
                    print(f'  calculated_balance: {calc_balance:.1f} MW')
                print()
                break
        else:
            print('No 16:00 interval found in API response')
            print(f'Available intervals: {[i["timestamp"] for i in data[:5]]}')
    else:
        print(f'API request failed with status {response.status_code}')
        print(f'Response: {response.text}')
        
except Exception as e:
    print(f'Error testing API: {e}')
