import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.data.power_generation_collector import PowerGenerationCollector
import logging
import time

logging.basicConfig(level=logging.INFO)

collector = PowerGenerationCollector()

print('🔄 Testing multiple fresh data collections...')
for i in range(3):
    print(f'\n--- Collection {i+1} ---')
    success = collector.collect_current_data(force_update=True)
    print(f'Collection result: {success}')
    
    # Get latest data immediately after collection
    latest = collector.get_latest_data()
    if latest:
        print(f'Stored: {latest["totals"]["production"]}MW production, {latest["totals"]["consumption"]}MW consumption')
    
    if i < 2:  # Don't sleep after last iteration
        time.sleep(2)  # Wait 2 seconds between collections

print('\n✅ Multiple collection test completed!')
