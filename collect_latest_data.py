from datetime import datetime, timedelta
from src.data.collector import DataCollector

# Initialize collector
collector = DataCollector('config.yaml')

# Try to collect today's data specifically
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow = today + timedelta(days=1)

print(f'Attempting to collect today\'s data: {today.strftime("%Y-%m-%d")}')

# Try to collect today's prices with force_update
print('\n=== Collecting Today\'s Price Data ===')
try:
    price_success = collector.collect_imbalance_prices(today, tomorrow, force_update=True)
    print(f'Price collection success: {price_success}')
except Exception as e:
    print(f'Error collecting today\'s prices: {e}')

# Try to collect today's volumes with force_update
print('\n=== Collecting Today\'s Volume Data ===')
try:
    volume_success = collector.collect_imbalance_volumes(today, tomorrow, force_update=True)
    print(f'Volume collection success: {volume_success}')
except Exception as e:
    print(f'Error collecting today\'s volumes: {e}')

print('\n=== Collection attempt complete ===')

# Check what we have now
from src.data.models import ImbalancePrice, get_session

with get_session() as session:
    # Get today's latest data
    latest_today = session.query(ImbalancePrice).filter(
        ImbalancePrice.timestamp >= today,
        ImbalancePrice.timestamp < tomorrow
    ).order_by(ImbalancePrice.timestamp.desc()).limit(5).all()
    
    print('\nLatest data for today after collection attempt:')
    if latest_today:
        for price in latest_today:
            print(f'  {price.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Price: {price.value}')
    else:
        print('  No data found for today')
