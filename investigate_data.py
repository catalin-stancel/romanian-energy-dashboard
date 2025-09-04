#!/usr/bin/env python3

from src.data.collector import DataCollector
from datetime import datetime, timedelta
import sqlite3

# Check what data we have in the database
collector = DataCollector()
stats = collector.get_collection_stats()

print('=== DATABASE STATISTICS ===')
print(f'Total price records: {stats["total_price_records"]}')
print(f'Total volume records: {stats["total_volume_records"]}')

if stats['price_date_range']:
    print(f'Price data range: {stats["price_date_range"]["min"]} to {stats["price_date_range"]["max"]}')

if stats['volume_date_range']:
    print(f'Volume data range: {stats["volume_date_range"]["min"]} to {stats["volume_date_range"]["max"]}')

print('\n=== RECENT COLLECTIONS ===')
for collection in stats['recent_collections'][:5]:
    print(f'{collection["data_type"]}: {collection["records_count"]} records - {collection["status"]} - {collection["created_at"]}')

# Check today's data specifically
print('\n=== TODAY\'S DATA CHECK ===')
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow = today + timedelta(days=1)

conn = sqlite3.connect('data/balancing_market.db')
cursor = conn.cursor()

# Check price data for today
cursor.execute('SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM imbalance_prices WHERE timestamp >= ? AND timestamp < ?', (today, tomorrow))
price_today = cursor.fetchone()
print(f'Price records today: {price_today[0]} (from {price_today[1]} to {price_today[2]})')

# Check volume data for today  
cursor.execute('SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM imbalance_volumes WHERE timestamp >= ? AND timestamp < ?', (today, tomorrow))
volume_today = cursor.fetchone()
print(f'Volume records today: {volume_today[0]} (from {volume_today[1]} to {volume_today[2]})')

# Check yesterday's data
yesterday = today - timedelta(days=1)
print(f'\n=== YESTERDAY\'S DATA CHECK ===')

cursor.execute('SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM imbalance_prices WHERE timestamp >= ? AND timestamp < ?', (yesterday, today))
price_yesterday = cursor.fetchone()
print(f'Price records yesterday: {price_yesterday[0]} (from {price_yesterday[1]} to {price_yesterday[2]})')

cursor.execute('SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM imbalance_volumes WHERE timestamp >= ? AND timestamp < ?', (yesterday, today))
volume_yesterday = cursor.fetchone()
print(f'Volume records yesterday: {volume_yesterday[0]} (from {volume_yesterday[1]} to {volume_yesterday[2]})')

conn.close()
