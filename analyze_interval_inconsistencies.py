#!/usr/bin/env python3

import sqlite3
import pandas as pd

def analyze_interval_inconsistencies():
    """Analyze interval data inconsistencies in the Power generation Data table."""
    
    # Connect to database
    conn = sqlite3.connect('data/balancing_market.db')
    
    # Query power generation data with calculated total balance
    query = '''
    SELECT 
        timestamp,
        total_production,
        total_consumption,
        imports,
        exports,
        net_balance,
        (total_production + imports) - (total_consumption + exports) as total_balance
    FROM power_generation_data 
    WHERE date(timestamp) = '2025-08-19'
        AND time(timestamp) >= '14:00:00'
    ORDER BY timestamp DESC
    '''
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    print('INTERVAL DATA INCONSISTENCY ANALYSIS')
    print('=' * 60)
    print()
    
    # Group by total balance patterns
    perfect_balance = df[df['total_balance'] == 0.0]
    low_balance = df[(df['total_balance'] > 0) & (df['total_balance'] <= 50)]
    high_balance = df[df['total_balance'] > 400]
    
    print(f'PERFECT BALANCE (0 MW): {len(perfect_balance)} intervals')
    for _, row in perfect_balance.iterrows():
        ts = row['timestamp']
        tb = row['total_balance']
        print(f'  {ts}: Total Balance = {tb}MW')
    
    print()
    print(f'LOW BALANCE (1-50 MW): {len(low_balance)} intervals')
    for _, row in low_balance.iterrows():
        ts = row['timestamp']
        tb = row['total_balance']
        print(f'  {ts}: Total Balance = {tb}MW')
    
    print()
    print(f'HIGH BALANCE (400+ MW): {len(high_balance)} intervals')
    for _, row in high_balance.iterrows():
        ts = row['timestamp']
        tb = row['total_balance']
        print(f'  {ts}: Total Balance = {tb}MW')
    
    print()
    print('DETAILED ANALYSIS:')
    print('=' * 40)
    
    # Check if there's a pattern in the data
    print('Total Balance Distribution:')
    balance_counts = df['total_balance'].value_counts().sort_index()
    for balance, count in balance_counts.items():
        print(f'  {balance}MW: {count} intervals')
    
    print()
    print('POTENTIAL ISSUE IDENTIFICATION:')
    print('The data shows distinct patterns:')
    print('1. Recent intervals (17:00): Perfect balance (0 MW)')
    print('2. Earlier intervals (14:00-16:45): High imbalance (400+ MW)')
    print('3. One anomaly at 16:45: Very low balance (9 MW)')
    print()
    print('This suggests a systematic change in data collection or calculation method.')
    print()
    
    # Show the transition point
    print('TRANSITION ANALYSIS:')
    print('=' * 30)
    print('Looking at the transition from high balance to perfect balance:')
    
    # Sort by timestamp to see chronological order
    df_sorted = df.sort_values('timestamp')
    for _, row in df_sorted.iterrows():
        ts = row['timestamp']
        tb = row['total_balance']
        prod = row['total_production']
        cons = row['total_consumption']
        imp = row['imports']
        exp = row['exports']
        print(f'{ts}: TB={tb}MW (P={prod}, C={cons}, I={imp}, E={exp})')

if __name__ == '__main__':
    analyze_interval_inconsistencies()
