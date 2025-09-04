import sqlite3
import sys
sys.path.append('src')

# Connect to database
conn = sqlite3.connect('data/balancing_market.db')
cursor = conn.cursor()

# Get all table names
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = cursor.fetchall()

print('=== DATABASE TABLES ===')
for table in tables:
    print(f'- {table[0]}')

print('\n=== TABLE SCHEMAS ===')
for table in tables:
    table_name = table[0]
    cursor.execute(f'PRAGMA table_info({table_name})')
    columns = cursor.fetchall()
    print(f'\n{table_name}:')
    for col in columns:
        print(f'  {col[1]} ({col[2]})')

conn.close()
