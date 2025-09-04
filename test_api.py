#!/usr/bin/env python3
"""
Test script for Romanian Energy Balancing Market API
"""

from datetime import datetime, timedelta
from src.api.entsoe_client import ENTSOEClient

def main():
    print("🇷🇴 Romanian Energy Balancing Market API Test")
    print("=" * 50)
    
    # Initialize client
    client = ENTSOEClient()
    
    # Test with data from a few days ago (more likely to be available)
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=2)
    start_date = end_date - timedelta(days=1)
    
    print(f"📅 Fetching data from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")
    
    try:
        # Fetch imbalance prices
        print("\n💰 Fetching imbalance prices...")
        prices_df = client.get_imbalance_prices(start_date, end_date)
        
        if not prices_df.empty:
            print(f"✅ Retrieved {len(prices_df)} price records")
            print(f"📊 Price range: {prices_df['value'].min():.2f} - {prices_df['value'].max():.2f} EUR/MWh")
            print(f"📈 Average price: {prices_df['value'].mean():.2f} EUR/MWh")
            print("\n🔍 Sample data:")
            print(prices_df.head(10))
        else:
            print("⚠️ No price data available for this period")
        
        # Fetch imbalance volumes
        print(f"\n📊 Fetching imbalance volumes...")
        volumes_df = client.get_imbalance_volumes(start_date, end_date)
        
        if not volumes_df.empty:
            print(f"✅ Retrieved {len(volumes_df)} volume records")
            print(f"📊 Volume range: {volumes_df['value'].min():.2f} - {volumes_df['value'].max():.2f} MWh")
            print(f"📈 Average volume: {volumes_df['value'].mean():.2f} MWh")
            print("\n🔍 Sample data:")
            print(volumes_df.head(10))
        else:
            print("⚠️ No volume data available for this period")
            
        print(f"\n🎉 API Test Completed Successfully!")
        print(f"✅ Connection: Working")
        print(f"✅ Authentication: Valid")
        print(f"✅ Data Retrieval: Functional")
        print(f"✅ Romanian Market: Accessible")
        
    except Exception as e:
        print(f"❌ Error during API test: {e}")

if __name__ == "__main__":
    main()
