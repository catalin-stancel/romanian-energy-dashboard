#!/usr/bin/env python3
"""
Test the power generation collector methods directly.
"""

from src.data.power_generation_collector import PowerGenerationCollector
from datetime import datetime, timedelta

def test_collector_methods():
    collector = PowerGenerationCollector()

    # Test get_latest_data
    print('Testing get_latest_data...')
    try:
        latest = collector.get_latest_data()
        if latest:
            print('✅ get_latest_data works')
            print(f'   Production: {latest["totals"]["production"]}MW')
            print(f'   Consumption: {latest["totals"]["consumption"]}MW')
            print(f'   Net Balance: {latest["totals"]["net_balance"]}MW')
        else:
            print('❌ get_latest_data returned None')
    except Exception as e:
        print(f'❌ get_latest_data failed: {e}')

    # Test get_interval_data
    print('\nTesting get_interval_data...')
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)

    try:
        interval_data = collector.get_interval_data(today, tomorrow)
        print(f'✅ get_interval_data works - found {len(interval_data)} intervals')
        
        if interval_data:
            # Show first few intervals
            for i, (timestamp, data) in enumerate(list(interval_data.items())[:3]):
                print(f'   Interval {i+1}: {timestamp} - {data["totals"]["production"]}MW production')
        
    except Exception as e:
        print(f'❌ get_interval_data failed: {e}')
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_collector_methods()
