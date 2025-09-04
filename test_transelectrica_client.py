"""
Test script for Transelectrica client.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.api.transelectrica_client import TranselectricaClient
import logging

# Set up basic logging
logging.basicConfig(level=logging.DEBUG, format='%(levelname)s: %(message)s')

def test_client():
    print("🔧 Testing Transelectrica API client...")
    
    try:
        client = TranselectricaClient()
        
        # Test fetching data
        print("📡 Fetching power data...")
        data = client.fetch_power_data()
        
        if data:
            print("✅ Successfully fetched data!")
            print(f"📊 Timestamp: {data['timestamp']}")
            print(f"⚡ Production: {data['totals']['production']:.0f} MW")
            print(f"🏠 Consumption: {data['totals']['consumption']:.0f} MW")
            print(f"⚖️ Net Balance: {data['totals']['net_balance']:.0f} MW")
            
            print("\n🏭 Generation by Source:")
            for source, value in data['generation'].items():
                if value > 0:
                    print(f"  {source.capitalize()}: {value:.0f} MW")
            
            print("\n🔌 Interconnections:")
            for connection, value in data['interconnections'].items():
                if abs(value) > 0:
                    direction = "export" if value > 0 else "import"
                    country = connection.replace('interconnection_', '').capitalize()
                    print(f"  {country}: {abs(value):.0f} MW ({direction})")
            
            return True
        else:
            print("❌ Failed to fetch data")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == "__main__":
    success = test_client()
    if success:
        print("\n🎉 Test completed successfully!")
    else:
        print("\n💥 Test failed!")
        sys.exit(1)
