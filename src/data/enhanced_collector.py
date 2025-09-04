"""
Enhanced data collector for Romanian Energy Balancing Market with bidirectional volume support.
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, Tuple
import pandas as pd
from sqlalchemy.orm import Session

from .models import (
    ImbalancePrice, EnhancedImbalanceVolume, NetImbalanceVolume, 
    DataCollectionLog, get_session, create_database_engine
)
from ..api.enhanced_entsoe_client import EnhancedENTSOEClient

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
    
    def _store_enhanced_volumes(self, volumes_df: pd.DataFrame, force_update: bool = False) -> int:
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
    
    def _store_net_volumes(self, net_volumes_df: pd.DataFrame, force_update: bool = False) -> int:
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
                       records_collected: int, success: bool, error_message: Optional[str] = None,
                       duration_seconds: Optional[float] = None):
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
    
    def get_latest_net_volumes(self, hours_back: int = 24) -> pd.DataFrame:
        """Get latest net volume data with deficit/surplus status."""
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=hours_back)
        
        with get_session(self.engine) as session:
            records = session.query(NetImbalanceVolume).filter(
                NetImbalanceVolume.timestamp >= start_time,
                NetImbalanceVolume.timestamp <= end_time
            ).order_by(NetImbalanceVolume.timestamp).all()
            
            if not records:
                return pd.DataFrame()
            
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
            
            return pd.DataFrame(data)
    
    def get_volume_statistics(self, date: datetime) -> dict:
        """Get volume statistics for a specific date."""
        start_date = date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        with get_session(self.engine) as session:
            records = session.query(NetImbalanceVolume).filter(
                NetImbalanceVolume.timestamp >= start_date,
                NetImbalanceVolume.timestamp < end_date
            ).all()
            
            if not records:
                return {}
            
            # Calculate statistics
            net_volumes = [r.net_volume for r in records]
            statuses = [r.status for r in records]
            
            stats = {
                'total_intervals': len(records),
                'avg_net_volume': sum(net_volumes) / len(net_volumes),
                'max_surplus': max([v for v in net_volumes if v > 0], default=0),
                'max_deficit': min([v for v in net_volumes if v < 0], default=0),
                'surplus_intervals': statuses.count('Surplus'),
                'deficit_intervals': statuses.count('Deficit'),
                'balanced_intervals': statuses.count('Balanced'),
                'total_import': sum(r.import_volume for r in records),
                'total_export': sum(r.export_volume for r in records)
            }
            
            return stats


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
        net_volumes_df = collector.get_latest_net_volumes(24)
        
        if not net_volumes_df.empty:
            print(f"\n📊 Retrieved {len(net_volumes_df)} net volume records")
            
            # Show status distribution
            status_counts = net_volumes_df['status'].value_counts()
            print(f"Status distribution:")
            for status, count in status_counts.items():
                print(f"  - {status}: {count} intervals")
            
            # Show sample data
            print(f"\n📈 Sample Net Volume Data:")
            sample_df = net_volumes_df.head(10)
            for _, row in sample_df.iterrows():
                print(f"  {row['timestamp'].strftime('%H:%M')}: Import={row['import_volume']:.1f}, Export={row['export_volume']:.1f}, Net={row['net_volume']:.1f} MWH -> {row['status']}")
            
            # Get statistics
            today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            stats = collector.get_volume_statistics(today)
            
            if stats:
                print(f"\n📈 Daily Volume Statistics:")
                print(f"  - Total intervals: {stats['total_intervals']}")
                print(f"  - Average net volume: {stats['avg_net_volume']:.1f} MWH")
                print(f"  - Max surplus: {stats['max_surplus']:.1f} MWH")
                print(f"  - Max deficit: {stats['max_deficit']:.1f} MWH")
                print(f"  - Surplus intervals: {stats['surplus_intervals']}")
                print(f"  - Deficit intervals: {stats['deficit_intervals']}")
                print(f"  - Balanced intervals: {stats['balanced_intervals']}")
        else:
            print("❌ No net volume data found in database")
    else:
        print("❌ Enhanced volume collection failed")


if __name__ == "__main__":
    test_enhanced_collector()
