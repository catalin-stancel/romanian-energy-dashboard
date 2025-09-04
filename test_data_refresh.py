import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.data.power_generation_collector import PowerGenerationCollector
import logging

logging.basicConfig(level=logging.INFO)

collector = PowerGenerationCollector()
print('🔄 Forcing fresh data collection...')
success = collector.collect_current_data(force_update=True)
print(f'Collection result: {success}')

# Get latest data
latest = collector.get_latest_data()
if latest:
    print(f'📊 Latest stored data:')
    print(f'  Timestamp: {latest["timestamp"]}')
    print(f'  Production: {latest["totals"]["production"]}MW')
    print(f'  Consumption: {latest["totals"]["consumption"]}MW')
    print(f'  Net Balance: {latest["totals"]["net_balance"]}MW')
