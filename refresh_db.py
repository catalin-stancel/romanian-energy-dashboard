import sys
import os
sys.path.append('.')
from src.data.models import ImbalancePrice, ImbalanceVolume, get_session
from src.data.collector import DataCollector
from datetime import datetime, timedelta

# Clear today's data and re-collect
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow = today + timedelta(days=1)

print('=== CLEARING TODAY\'S DATA ===')
with get_session() as session:
    # Delete today's data
    price_deleted = session.query(ImbalancePrice).filter(
        ImbalancePrice.timestamp >= today,
        ImbalancePrice.timestamp < tomorrow
    ).delete()
    
    volume_deleted = session.query(ImbalanceVolume).filter(
        ImbalanceVolume.timestamp >= today,
        ImbalanceVolume.timestamp < tomorrow
    ).delete()
    
    session.commit()
    print(f'Deleted {price_deleted} price records and {volume_deleted} volume records')

print('\n=== RE-COLLECTING TODAY\'S DATA ===')
collector = DataCollector()

# Force collect today's data
price_success = collector.collect_imbalance_prices(today, tomorrow, force_update=True)
volume_success = collector.collect_imbalance_volumes(today, tomorrow, force_update=True)

print(f'Price collection: {"Success" if price_success else "Failed"}')
print(f'Volume collection: {"Success" if volume_success else "Failed"}')

# Verify the new data
print('\n=== VERIFYING NEW DATA ===')
with get_session() as session:
    price_count = session.query(ImbalancePrice).filter(
        ImbalancePrice.timestamp >= today,
        ImbalancePrice.timestamp < tomorrow
    ).count()
    
    volume_count = session.query(ImbalanceVolume).filter(
        ImbalanceVolume.timestamp >= today,
        ImbalanceVolume.timestamp < tomorrow
    ).count()
    
    print(f'New price records: {price_count}')
    print(f'New volume records: {volume_count}')
    
    # Sample some volume records
    volumes = session.query(ImbalanceVolume).filter(
        ImbalanceVolume.timestamp >= today,
        ImbalanceVolume.timestamp < tomorrow
    ).order_by(ImbalanceVolume.timestamp).limit(5).all()
    
    print('\n=== SAMPLE VOLUME RECORDS ===')
    for v in volumes:
        print(f'{v.timestamp}: {v.value} {v.measure_unit}')

print('\n✅ Database refresh completed!')
