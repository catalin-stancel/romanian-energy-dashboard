import requests
import json

try:
    response = requests.get('http://localhost:8000/api/daily-intervals')
    data = response.json()
    
    print('=== API RESPONSE ANALYSIS ===')
    print(f'Date: {data["date"]}')
    print(f'Total intervals: {data["total_intervals"]}')
    print(f'Current interval: {data["current_interval"]}')
    
    # Check first few intervals for data
    print('\n=== FIRST 10 INTERVALS ===')
    for i, interval in enumerate(data['intervals'][:10]):
        price = interval['price'] if interval['price'] is not None else 'No data'
        volume = interval['volume'] if interval['volume'] is not None else 'No data'
        status = interval['surplus_deficit'] if interval['surplus_deficit'] else 'No data'
        print(f'{interval["time"]}: Price={price}, Volume={volume}, Status={status}')
    
    # Count intervals with data
    price_count = sum(1 for i in data['intervals'] if i['price'] is not None)
    volume_count = sum(1 for i in data['intervals'] if i['volume'] is not None)
    status_count = sum(1 for i in data['intervals'] if i['surplus_deficit'] is not None)
    
    print(f'\n=== DATA COVERAGE ===')
    print(f'Intervals with price data: {price_count}/96')
    print(f'Intervals with volume data: {volume_count}/96')
    print(f'Intervals with status data: {status_count}/96')
    
    # Check some intervals with volume data
    print('\n=== INTERVALS WITH VOLUME DATA ===')
    volume_intervals = [i for i in data['intervals'] if i['volume'] is not None]
    for interval in volume_intervals[:5]:
        print(f'{interval["time"]}: Price={interval["price"]}, Volume={interval["volume"]}, Status={interval["surplus_deficit"]}')
    
except Exception as e:
    print(f'Error: {e}')
