from datetime import datetime, timedelta
from src.data.collector import DataCollector
import pytz

# Initialize collector
collector = DataCollector('config.yaml')

# Test with yesterday's data (should be available)
yesterday = datetime.now() - timedelta(days=1)
start_time = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
end_time = start_time + timedelta(days=1)

print(f'Testing timezone fix with yesterday\'s data: {start_time.strftime("%Y-%m-%d %H:%M:%S")} to {end_time.strftime("%Y-%m-%d %H:%M:%S")}')

# Collect yesterday's prices to test timezone conversion
print('\n=== Testing Price Data Timezone Conversion ===')
try:
    price_success = collector.collect_imbalance_prices(start_time, end_time, force_update=True)
    print(f'Price collection success: {price_success}')
    
    # Check the database to see what timestamps were stored
    from src.data.models import ImbalancePrice, get_session
    with get_session() as session:
        # Get a few sample records from yesterday
        sample_prices = session.query(ImbalancePrice).filter(
            ImbalancePrice.timestamp >= start_time,
            ImbalancePrice.timestamp < end_time
        ).order_by(ImbalancePrice.timestamp).limit(5).all()
        
        if sample_prices:
            print(f'\nSample price timestamps (should be in Romanian time):')
            for price in sample_prices:
                print(f'  {price.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Price: {price.value}')
        else:
            print('No price data found for yesterday')
            
except Exception as e:
    print(f'Error collecting prices: {e}')

print('\n=== Testing Volume Data Timezone Conversion ===')
try:
    volume_success = collector.collect_imbalance_volumes(start_time, end_time, force_update=True)
    print(f'Volume collection success: {volume_success}')
    
    # Check the database to see what timestamps were stored
    from src.data.models import ImbalanceVolume
    with get_session() as session:
        # Get a few sample records from yesterday
        sample_volumes = session.query(ImbalanceVolume).filter(
            ImbalanceVolume.timestamp >= start_time,
            ImbalanceVolume.timestamp < end_time
        ).order_by(ImbalanceVolume.timestamp).limit(5).all()
        
        if sample_volumes:
            print(f'\nSample volume timestamps (should be in Romanian time):')
            for volume in sample_volumes:
                print(f'  {volume.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Volume: {volume.value}')
        else:
            print('No volume data found for yesterday')
            
except Exception as e:
    print(f'Error collecting volumes: {e}')

print('\n=== Timezone Fix Test Complete ===')
print(f'Current Romanian time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')

# Show what the 17:15 interval should look like now
romanian_tz = pytz.timezone('Europe/Bucharest')
current_romanian = datetime.now(romanian_tz)
print(f'Current time with timezone: {current_romanian.strftime("%Y-%m-%d %H:%M:%S %Z")}')
