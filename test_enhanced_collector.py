"""
Test script for enhanced data collector.
"""

import sys
import os
sys.path.append('.')

from datetime import datetime, timedelta
import logging

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

from src.data.models import (
    EnhancedImbalanceVolume, NetImbalanceVolume, 
    DataCollectionLog, get_session, create_database_engine
)
from src.api.enhanced_entsoe_client import EnhancedENTSOEClient

logger = logging.getLogger(__name__)


class EnhancedDataCollector:
    """Enhanced data collector with bidirectional volume support and deficit/surplus calculation."""
    
    def __init__(self):
        self.client = EnhancedENTSOEClient()
        self.engine = create_database_engine()
        logger.info("Initialized Enhanced Data Collector")
    
    def collect_enhanced_imbalance_volumes(self, 
                                         start_date: datetime, 
                                         end_date: datetime,
                                         force_update: bool = False) -> bool:
        """
        Collect enhanced imbalance volumes with bidirectional flow data.
        
        Args:
            start_date: Start date for data collection
            end_date: End date for data collection
            force_update: If True, update existing records
        
        Returns:
            True if collection was successful, False otherwise
        """
        collection_start = datetime.now()
        
        try:
            logger.info(f"Starting enhanced volume collection from {start_date} to {end_date}")
            
            # Get enhanced volume data from API
            volumes_df = self.client.get_enhanced_imbalance_volumes(start_date, end_date)
            
            if volumes_df.empty:
                logger.warning("No enhanced volume data retrieved from API")
                self._log_collection('enhanced_volumes', start_date, end_date, 0, False, "No data from API")
                return False
            
            # Calculate net volumes
            net_volumes_df = self.client.calculate_net_imbalance_volumes(volumes_df)
            
            if net_volumes_df.empty:
                logger.warning("No net volume data calculated")
                self._log_collection('enhanced_volumes', start_date, end_date, 0, False, "No net volumes calculated")
                return False
            
            # Store data in database
            enhanced_records_stored = self._store_enhanced_volumes(volumes_df, force_update)
            net_records_stored = self._store_net_volumes(net_volumes_df, force_update)
            
            total_records = enhanced_records_stored + net_records_stored
            
            # Log successful collection
            duration = (datetime.now() - collection_start).total_seconds()
            self._log_collection('enhanced_volumes', start_date, end_date, total_records, True, 
                               None, duration)
            
            logger.info(f"✅ Enhanced volume collection completed: {enhanced_records_stored} enhanced + {net_records_stored} net records")
            return True
            
        except Exception as e:
            logger.error(f"Enhanced volume collection failed: {e}")
            duration = (datetime.now() - collection_start).total_seconds()
            self._log_collection('enhanced_volumes', start_date, end_date, 0, False, str(e), duration)
            return False
    
    def _store_enhanced_volumes(self, volumes_df, force_update: bool = False) -> int:
        """Store enhanced volume data with flow directions."""
        if volumes_df.empty:
            return 0
        
        stored_count = 0
        
        with get_session(self.engine) as session:
            for _, row in volumes_df.iterrows():
                # Check if record already exists
                existing = session.query(EnhancedImbalanceVolume).filter(
                    EnhancedImbalanceVolume.timestamp == row['timestamp'],
                    EnhancedImbalanceVolume.flow_direction == row['flow_direction']
                ).first()
                
                if existing and not force_update:
                    continue
                
                if existing and force_update:
                    # Update existing record
                    existing.value = row['value']
                    existing.business_type = row.get('business_type')
                    existing.measure_unit = row.get('measure_unit')
                    existing.resolution_minutes = row.get('resolution_minutes')
                    existing.updated_at = datetime.utcnow()
                else:
                    # Create new record
                    volume_record = EnhancedImbalanceVolume(
                        timestamp=row['timestamp'],
                        value=row['value'],
                        flow_direction=row['flow_direction'],
                        business_type=row.get('business_type'),
                        measure_unit=row.get('measure_unit'),
                        resolution_minutes=row.get('resolution_minutes')
                    )
                    session.add(volume_record)
                
                stored_count += 1
            
            session.commit()
        
        logger.info(f"Stored {stored_count} enhanced volume records")
        return stored_count
    
    def _store_net_volumes(self, net_volumes_df, force_update: bool = False) -> int:
        """Store calculated net volume data with deficit/surplus status."""
        if net_volumes_df.empty:
            return 0
        
        stored_count = 0
        
        with get_session(self.engine) as session:
            for _, row in net_volumes_df.iterrows():
                # Check if record already exists
                existing = session.query(NetImbalanceVolume).filter(
                    NetImbalanceVolume.timestamp == row['timestamp']
                ).first()
                
                if existing and not force_update:
                    continue
                
                if existing and force_update:
                    # Update existing record
                    existing.import_volume = row['import_volume']
                    existing.export_volume = row['export_volume']
                    existing.net_volume = row['net_volume']
                    existing.status = row['status']
                    existing.measure_unit = row.get('measure_unit', 'MWH')
                    existing.updated_at = datetime.utcnow()
                else:
                    # Create new record
                    net_volume_record = NetImbalanceVolume(
                        timestamp=row['timestamp'],
                        import_volume=row['import_volume'],
                        export_volume=row['export_volume'],
                        net_volume=row['net_volume'],
                        status=row['status'],
                        measure_unit=row.get('measure_unit', 'MWH')
                    )
                    session.add(net_volume_record)
                
                stored_count += 1
            
            session.commit()
        
        logger.info(f"Stored {stored_count} net volume records")
        return stored_count
    
    def _log_collection(self, collection_type: str, start_date: datetime, end_date: datetime,
                       records_collected: int, success: bool, error_message: str = None,
                       duration_seconds: float = None):
        """Log data collection activity."""
        with get_session(self.engine) as session:
            log_entry = DataCollectionLog(
                collection_type=collection_type,
                start_date=start_date,
                end_date=end_date,
                records_collected=records_collected,
                success=success,
                error_message=error_message,
                duration_seconds=duration_seconds
            )
            session.add(log_entry)
            session.commit()
    
    def get_latest_net_volumes(self, hours_back: int = 24):
        """Get latest net volume data with deficit/surplus status."""
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=hours_back)
        
        with get_session(self.engine) as session:
            records = session.query(NetImbalanceVolume).filter(
                NetImbalanceVolume.timestamp >= start_time,
                NetImbalanceVolume.timestamp <= end_time
            ).order_by(NetImbalanceVolume.timestamp).all()
            
            if not records:
                return []
            
            data = []
            for record in records:
                data.append({
                    'timestamp': record.timestamp,
                    'import_volume': record.import_volume,
                    'export_volume': record.export_volume,
                    'net_volume': record.net_volume,
                    'status': record.status,
                    'measure_unit': record.measure_unit
                })
            
            return data


def test_enhanced_collector():
    """Test the enhanced data collector."""
    collector = EnhancedDataCollector()
    
    # Test with today's data
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start_date = end_date - timedelta(days=1)
    
    print(f"🔍 Testing Enhanced Data Collector")
    print(f"Period: {start_date} to {end_date}")
    print("=" * 60)
    
    # Collect enhanced volume data
    success = collector.collect_enhanced_imbalance_volumes(start_date, end_date, force_update=True)
    
    if success:
        print("✅ Enhanced volume collection successful")
        
        # Get latest net volumes
        net_volumes_data = collector.get_latest_net_volumes(24)
        
        if net_volumes_data:
            print(f"\n📊 Retrieved {len(net_volumes_data)} net volume records")
            
            # Show status distribution
            statuses = [record['status'] for record in net_volumes_data]
            status_counts = {}
            for status in statuses:
                status_counts[status] = status_counts.get(status, 0) + 1
            
            print(f"Status distribution:")
            for status, count in status_counts.items():
                print(f"  - {status}: {count} intervals")
            
            # Show sample data
            print(f"\n📈 Sample Net Volume Data:")
            for i, record in enumerate(net_volumes_data[:10]):
                timestamp = record['timestamp']
                time_str = timestamp.strftime('%H:%M')
                import_vol = record['import_volume']
                export_vol = record['export_volume']
                net_vol = record['net_volume']
                status = record['status']
                print(f"  {time_str}: Import={import_vol:.1f}, Export={export_vol:.1f}, Net={net_vol:.1f} MWH -> {status}")
        else:
            print("❌ No net volume data found in database")
    else:
        print("❌ Enhanced volume collection failed")


if __name__ == "__main__":
    test_enhanced_collector()
