#!/usr/bin/env python3

import requests
import json

def test_historical_intervals():
    """Test that historical interval data is preserved."""
    try:
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        if response.status_code == 200:
            data = response.json()
            print('📊 Power Generation Intervals Summary:')
            print(f'📅 Date: {data["date"]}')
            print(f'📈 Total intervals: {data["total_intervals"]}')
            print(f'🔢 Historical intervals: {data["historical_intervals"]}')
            print(f'⏰ Current interval: {data["current_interval"]}')
            print()
            
            # Show intervals with data
            intervals_with_data = [i for i in data['intervals'] if i['has_data']]
            print(f'✅ Intervals with data: {len(intervals_with_data)}')
            
            for interval in intervals_with_data:
                status_icon = '🟢' if interval['status'] == 'Surplus' else '🔴' if interval['status'] == 'Deficit' else '🟡'
                current_marker = ' ← CURRENT' if interval['is_current'] else ''
                print(f'  {status_icon} {interval["time"]}: {interval["production"]}MW → {interval["consumption"]}MW = {interval["net_balance"]}MW ({interval["status"]}){current_marker}')
            
            # Check if we have historical data (previous intervals)
            historical_count = len([i for i in intervals_with_data if not i['is_current']])
            if historical_count > 0:
                print(f'\n✅ SUCCESS: Found {historical_count} historical intervals with preserved data!')
                return True
            else:
                print(f'\n⚠️ WARNING: No historical intervals found, only current interval has data')
                return False
            
        else:
            print(f'❌ API Error: {response.status_code}')
            print(response.text)
            return False
            
    except Exception as e:
        print(f'❌ Error: {e}')
        return False

if __name__ == "__main__":
    test_historical_intervals()
