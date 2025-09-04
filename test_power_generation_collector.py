"""
Test script for PowerGenerationCollector.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.power_generation_collector import PowerGenerationCollector
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

def test_collector():
    print("🔧 Testing Power Generation Collector...")
    
    try:
        collector = PowerGenerationCollector()
        
        # Test connection
        print("🌐 Testing connection...")
        if collector.test_connection():
            print("✅ Connection test passed")
        else:
            print("❌ Connection test failed")
            return False
        
        # Test data collection
        print("📊 Collecting power generation data...")
        if collector.collect_current_data(force_update=True):
            print("✅ Data collection successful")
            
            # Get latest data
            latest = collector.get_latest_data()
            if latest:
                print(f"📈 Latest data timestamp: {latest['timestamp']}")
                print(f"⚡ Production: {latest['totals']['production']:.0f} MW")
                print(f"🏠 Consumption: {latest['totals']['consumption']:.0f} MW")
                print(f"⚖️ Net Balance: {latest['totals']['net_balance']:.0f} MW")
                
                # Show generation mix
                mix = collector.get_generation_mix_percentage()
                if mix:
                    print("\n🏭 Generation Mix:")
                    for source, percentage in sorted(mix.items(), key=lambda x: x[1], reverse=True):
                        print(f"  {source.capitalize()}: {percentage}%")
                
                # Show interconnections
                print("\n🔌 Interconnections:")
                for country, value in latest['interconnections'].items():
                    if abs(value) > 0:
                        direction = "export" if value > 0 else "import"
                        print(f"  {country.capitalize()}: {abs(value):.0f} MW ({direction})")
            
            return True
        else:
            print("❌ Data collection failed")
            return False
            
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_collector()
    if success:
        print("\n🎉 Test completed successfully!")
    else:
        print("\n💥 Test failed!")
        sys.exit(1)
