from datetime import datetime, timedelta
from src.data.collector import DataCollector

# Initialize collector with config file path
collector = DataCollector('config.yaml')

# Get today's date
today = datetime.now().date()
start_time = datetime.combine(today, datetime.min.time())
end_time = datetime.combine(today, datetime.max.time())

print(f'Collecting TODAY\'s data: {start_time.strftime("%Y-%m-%d %H:%M:%S")} to {end_time.strftime("%Y-%m-%d %H:%M:%S")}')

# Collect today's prices with force_update=True to overwrite existing data
print('\n=== Collecting Today\'s Imbalance Prices ===')
try:
    price_records = collector.collect_imbalance_prices(start_time, end_time, force_update=True)
    print(f'Successfully collected {len(price_records)} price records for today')
except Exception as e:
    print(f'Error collecting prices: {e}')

# Collect today's volumes with force_update=True to overwrite existing data
print('\n=== Collecting Today\'s Imbalance Volumes ===')
try:
    volume_records = collector.collect_imbalance_volumes(start_time, end_time, force_update=True)
    print(f'Successfully collected {len(volume_records)} volume records for today')
except Exception as e:
    print(f'Error collecting volumes: {e}')

print('\n=== Data Collection Complete ===')
print(f'Current time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
