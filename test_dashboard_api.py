"""
Test script for enhanced dashboard API.
"""

import sys
sys.path.append('.')
import requests
import json
from datetime import datetime

def test_dashboard_api():
    """Test the enhanced dashboard API endpoints."""
    
    print('🔍 Testing Enhanced Dashboard API')
    print('=' * 50)

    try:
        # Test the daily intervals API endpoint
        response = requests.get('http://localhost:8000/api/daily-intervals')
        
        if response.status_code == 200:
            data = response.json()
            intervals = data.get('intervals', [])
            
            print(f'✅ API Response successful')
            print(f'📊 Total intervals: {len(intervals)}')
            print(f'📅 Date: {data.get("date")}')
            
            # Check for enhanced volume data
            volume_intervals = [i for i in intervals if i.get('volume') is not None]
            status_intervals = [i for i in intervals if i.get('surplus_deficit') is not None]
            
            print(f'📈 Intervals with volume data: {len(volume_intervals)}')
            print(f'🎯 Intervals with status data: {len(status_intervals)}')
            
            # Show sample enhanced data
            print(f'\n📋 Sample Enhanced Volume Data:')
            count = 0
            for interval in intervals:
                if interval.get('volume') is not None and count < 10:
                    time = interval.get('time', '').split(' ')[1] if ' ' in interval.get('time', '') else interval.get('time', '')
                    volume = interval.get('volume')
                    status = interval.get('surplus_deficit', 'Unknown')
                    price = interval.get('price')
                    print(f'  {time}: Volume={volume:.1f} MWH, Status={status}, Price={price}')
                    count += 1
            
            # Check specific time that had issues before (18:00)
            evening_intervals = [i for i in intervals if '18:00' in i.get('time', '')]
            if evening_intervals:
                evening = evening_intervals[0]
                print(f'\n🕕 18:00 Data Check:')
                print(f'  Volume: {evening.get("volume")}')
                print(f'  Status: {evening.get("surplus_deficit")}')
                print(f'  Price: {evening.get("price")}')
            else:
                print(f'\n🕕 18:00 Data Check: No data found for 18:00')
            
            # Check coverage throughout the day
            morning_data = [i for i in intervals if i.get('volume') is not None and '06:00' <= i.get('time', '').split(' ')[1] <= '12:00']
            afternoon_data = [i for i in intervals if i.get('volume') is not None and '12:00' <= i.get('time', '').split(' ')[1] <= '18:00']
            evening_data = [i for i in intervals if i.get('volume') is not None and '18:00' <= i.get('time', '').split(' ')[1] <= '23:59']
            
            print(f'\n📊 Coverage Analysis:')
            print(f'  Morning (06:00-12:00): {len(morning_data)} intervals')
            print(f'  Afternoon (12:00-18:00): {len(afternoon_data)} intervals')
            print(f'  Evening (18:00-23:59): {len(evening_data)} intervals')
            
            # Status distribution
            status_counts = {}
            for interval in status_intervals:
                status = interval.get('surplus_deficit')
                status_counts[status] = status_counts.get(status, 0) + 1
            
            print(f'\n🎯 Status Distribution:')
            for status, count in status_counts.items():
                print(f'  {status}: {count} intervals')
            
            return True
            
        else:
            print(f'❌ API call failed with status {response.status_code}')
            print(f'Response: {response.text}')
            return False
            
    except requests.exceptions.ConnectionError:
        print('❌ Dashboard not running.')
        print('Please start the dashboard with: python src/web/app.py')
        return False
    except Exception as e:
        print(f'❌ Test failed: {e}')
        return False

if __name__ == "__main__":
    test_dashboard_api()
