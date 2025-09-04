"""
Data collection pipeline for Romanian energy balancing market data.
Handles automated data gathering from ENTSO-E API and database storage.
"""

import logging
import yaml
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
import pandas as pd
from sqlalchemy.orm import Session
from sqlalchemy import and_

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.api.entsoe_client import ENTSOEClient
from src.data.models import (
    ImbalancePrice, ImbalanceVolume, DataCollectionLog, 
    create_database_engine, get_session
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DataCollector:
    """Handles automated data collection from ENTSO-E API."""
    
    def __init__(self, config_path: str = "config.yaml"):
        """Initialize the data collector with configuration."""
        with open(config_path, 'r') as file:
            self.config = yaml.safe_load(file)
        
        self.client = ENTSOEClient()
        self.engine = create_database_engine()
        
    def collect_imbalance_prices(
        self, 
        start_date: datetime, 
        end_date: datetime,
        force_update: bool = False
    ) -> bool:
        """
        Collect imbalance price data for the specified date range.
        
        Args:
            start_date: Start date for data collection
            end_date: End date for data collection
            force_update: If True, overwrite existing data
            
        Returns:
            bool: True if collection was successful
        """
        try:
            logger.info(f"Collecting imbalance prices from {start_date} to {end_date}")
            
            # Check if data already exists (unless force_update is True)
            if not force_update:
                existing_data = self._check_existing_price_data(start_date, end_date)
                if existing_data:
                    logger.info("Data already exists for this period. Use force_update=True to overwrite.")
                    return True
            
            # Fetch data from API
            price_data = self.client.get_imbalance_prices(start_date, end_date)
            
            if price_data.empty:
                logger.warning("No price data received from API")
                return False
            
            # Store data in database
            records_stored = self._store_price_data(price_data, force_update)
            
            # Log the collection activity
            self._log_collection_activity(
                data_type="imbalance_prices",
                start_date=start_date,
                end_date=end_date,
                records_count=records_stored,
                status="success"
            )
            
            logger.info(f"Successfully stored {records_stored} price records")
            return True
            
        except Exception as e:
            logger.error(f"Error collecting imbalance prices: {str(e)}")
            self._log_collection_activity(
                data_type="imbalance_prices",
                start_date=start_date,
                end_date=end_date,
                records_count=0,
                status="error",
                error_message=str(e)
            )
            return False
    
    def collect_imbalance_volumes(
        self, 
        start_date: datetime, 
        end_date: datetime,
        force_update: bool = False
    ) -> bool:
        """
        Collect imbalance volume data for the specified date range.
        
        Args:
            start_date: Start date for data collection
            end_date: End date for data collection
            force_update: If True, overwrite existing data
            
        Returns:
            bool: True if collection was successful
        """
        try:
            logger.info(f"Collecting imbalance volumes from {start_date} to {end_date}")
            
            # Check if data already exists (unless force_update is True)
            if not force_update:
                existing_data = self._check_existing_volume_data(start_date, end_date)
                if existing_data:
                    logger.info("Data already exists for this period. Use force_update=True to overwrite.")
                    return True
            
            # Fetch data from API
            volume_data = self.client.get_imbalance_volumes(start_date, end_date)
            
            if volume_data.empty:
                logger.warning("No volume data received from API")
                return False
            
            # Store data in database
            records_stored = self._store_volume_data(volume_data, force_update)
            
            # Log the collection activity
            self._log_collection_activity(
                data_type="imbalance_volumes",
                start_date=start_date,
                end_date=end_date,
                records_count=records_stored,
                status="success"
            )
            
            logger.info(f"Successfully stored {records_stored} volume records")
            return True
            
        except Exception as e:
            logger.error(f"Error collecting imbalance volumes: {str(e)}")
            self._log_collection_activity(
                data_type="imbalance_volumes",
                start_date=start_date,
                end_date=end_date,
                records_count=0,
                status="error",
                error_message=str(e)
            )
            return False
    
    def collect_daily_data(self, target_date: datetime) -> bool:
        """
        Collect both price and volume data for a specific day.
        
        Args:
            target_date: The date to collect data for
            
        Returns:
            bool: True if both collections were successful
        """
        start_date = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        logger.info(f"Collecting daily data for {target_date.date()}")
        
        price_success = self.collect_imbalance_prices(start_date, end_date)
        volume_success = self.collect_imbalance_volumes(start_date, end_date)
        
        return price_success and volume_success
    
    def collect_recent_data(self, days_back: int = 7) -> bool:
        """
        Collect data for the last N days.
        
        Args:
            days_back: Number of days to go back from today
            
        Returns:
            bool: True if collection was successful
        """
        # First ensure we have 12 months of historical data
        self.ensure_12_months_data()
        
        end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        start_date = end_date - timedelta(days=days_back)
        
        logger.info(f"Collecting recent data for last {days_back} days")
        
        price_success = self.collect_imbalance_prices(start_date, end_date)
        volume_success = self.collect_imbalance_volumes(start_date, end_date)
        
        return price_success and volume_success
    
    def ensure_12_months_data(self) -> bool:
        """
        Ensure the database contains 12 months of historical data.
        Identifies missing date ranges and performs backfill collection.
        
        Returns:
            bool: True if 12 months of data is available or successfully backfilled
        """
        try:
            logger.info("Checking for 12 months of historical data...")
            
            # Calculate 12 months back from today
            end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            twelve_months_ago = end_date - timedelta(days=365)
            
            with get_session() as session:
                # Check earliest available data for both prices and volumes
                earliest_price = session.query(ImbalancePrice.timestamp)\
                    .order_by(ImbalancePrice.timestamp.asc()).first()
                earliest_volume = session.query(ImbalanceVolume.timestamp)\
                    .order_by(ImbalanceVolume.timestamp.asc()).first()
                
                # Determine what data we need to backfill
                missing_ranges = []
                
                if not earliest_price or earliest_price[0] > twelve_months_ago:
                    price_start = earliest_price[0] if earliest_price else end_date
                    missing_ranges.append({
                        'type': 'prices',
                        'start': twelve_months_ago,
                        'end': min(price_start, end_date)
                    })
                
                if not earliest_volume or earliest_volume[0] > twelve_months_ago:
                    volume_start = earliest_volume[0] if earliest_volume else end_date
                    missing_ranges.append({
                        'type': 'volumes',
                        'start': twelve_months_ago,
                        'end': min(volume_start, end_date)
                    })
                
                if not missing_ranges:
                    logger.info("✅ 12 months of historical data already available")
                    return True
                
                # Perform backfill for missing data
                logger.info(f"📥 Backfilling {len(missing_ranges)} missing data ranges...")
                
                for range_info in missing_ranges:
                    success = self._backfill_data_range(
                        range_info['type'],
                        range_info['start'],
                        range_info['end']
                    )
                    
                    if not success:
                        logger.warning(f"Failed to backfill {range_info['type']} data")
                        return False
                
                logger.info("✅ 12 months historical data backfill completed")
                return True
                
        except Exception as e:
            logger.error(f"Error ensuring 12 months data: {str(e)}")
            return False
    
    def _backfill_data_range(self, data_type: str, start_date: datetime, end_date: datetime) -> bool:
        """
        Backfill data for a specific date range in chunks to avoid API limits.
        
        Args:
            data_type: 'prices' or 'volumes'
            start_date: Start date for backfill
            end_date: End date for backfill
            
        Returns:
            bool: True if backfill was successful
        """
        try:
            logger.info(f"Backfilling {data_type} from {start_date.date()} to {end_date.date()}")
            
            # Process in 7-day chunks to avoid overwhelming the API
            chunk_size = timedelta(days=7)
            current_start = start_date
            total_success = True
            
            while current_start < end_date:
                current_end = min(current_start + chunk_size, end_date)
                
                logger.info(f"Processing chunk: {current_start.date()} to {current_end.date()}")
                
                if data_type == 'prices':
                    success = self.collect_imbalance_prices(
                        current_start, 
                        current_end, 
                        force_update=False
                    )
                elif data_type == 'volumes':
                    success = self.collect_imbalance_volumes(
                        current_start, 
                        current_end, 
                        force_update=False
                    )
                else:
                    logger.error(f"Unknown data type: {data_type}")
                    return False
                
                if not success:
                    logger.warning(f"Failed to backfill {data_type} chunk {current_start.date()}-{current_end.date()}")
                    total_success = False
                
                current_start = current_end
                
                # Small delay between chunks to be respectful to the API
                import time
                time.sleep(1)
            
            return total_success
            
        except Exception as e:
            logger.error(f"Error in backfill data range: {str(e)}")
            return False
    
    def _check_existing_price_data(self, start_date: datetime, end_date: datetime) -> bool:
        """Check if price data already exists for the given date range."""
        with get_session() as session:
            existing = session.query(ImbalancePrice).filter(
                and_(
                    ImbalancePrice.timestamp >= start_date,
                    ImbalancePrice.timestamp < end_date
                )
            ).first()
            return existing is not None
    
    def _check_existing_volume_data(self, start_date: datetime, end_date: datetime) -> bool:
        """Check if volume data already exists for the given date range."""
        with get_session() as session:
            existing = session.query(ImbalanceVolume).filter(
                and_(
                    ImbalanceVolume.timestamp >= start_date,
                    ImbalanceVolume.timestamp < end_date
                )
            ).first()
            return existing is not None
    
    def _store_price_data(self, price_data: pd.DataFrame, force_update: bool = False) -> int:
        """Store price data in the database."""
        records_stored = 0
        
        with get_session() as session:
            for _, row in price_data.iterrows():
                try:
                    # Check if record already exists
                    existing = session.query(ImbalancePrice).filter(
                        and_(
                            ImbalancePrice.timestamp == row['timestamp'],
                            ImbalancePrice.price_category == row.get('price_category', 'A04')
                        )
                    ).first()
                    
                    if existing and not force_update:
                        continue
                    elif existing and force_update:
                        # Update existing record
                        existing.value = row.get('price', row.get('value'))  # Handle both column names
                        existing.measure_unit = row.get('measure_unit', 'EUR/MWh')
                        existing.updated_at = datetime.now()
                    else:
                        # Create new record
                        price_record = ImbalancePrice(
                            timestamp=row['timestamp'],
                            value=row.get('price', row.get('value')),  # Handle both column names
                            business_type=row.get('business_type', 'A85'),
                            price_category=row.get('price_category', 'A04'),
                            currency=row.get('currency', 'EUR'),
                            measure_unit=row.get('measure_unit', 'EUR/MWh'),
                            resolution_minutes=row.get('resolution_minutes', 15)
                        )
                        session.add(price_record)
                    
                    records_stored += 1
                    
                except Exception as e:
                    logger.error(f"Error storing price record: {str(e)}")
                    continue
            
            session.commit()
        
        return records_stored
    
    def _store_volume_data(self, volume_data: pd.DataFrame, force_update: bool = False) -> int:
        """Store volume data in the database."""
        records_stored = 0
        
        with get_session() as session:
            for _, row in volume_data.iterrows():
                try:
                    # Check if record already exists
                    existing = session.query(ImbalanceVolume).filter(
                        and_(
                            ImbalanceVolume.timestamp == row['timestamp'],
                            ImbalanceVolume.business_type == row.get('business_type', 'A86')
                        )
                    ).first()
                    
                    if existing and not force_update:
                        continue
                    elif existing and force_update:
                        # Update existing record
                        existing.value = row['value']
                        existing.measure_unit = row.get('measure_unit', 'MWh')
                        existing.updated_at = datetime.now()
                    else:
                        # Create new record
                        volume_record = ImbalanceVolume(
                            timestamp=row['timestamp'],
                            value=row['value'],
                            business_type=row.get('business_type', 'A86'),
                            currency=row.get('currency', 'EUR'),
                            measure_unit=row.get('measure_unit', 'MWh'),
                            resolution_minutes=row.get('resolution_minutes', 15)
                        )
                        session.add(volume_record)
                    
                    records_stored += 1
                    
                except Exception as e:
                    logger.error(f"Error storing volume record: {str(e)}")
                    continue
            
            session.commit()
        
        return records_stored
    
    def _log_collection_activity(
        self, 
        data_type: str, 
        start_date: datetime, 
        end_date: datetime,
        records_count: int, 
        status: str, 
        error_message: Optional[str] = None
    ):
        """Log data collection activity."""
        with get_session() as session:
            log_entry = DataCollectionLog(
                collection_type=data_type,
                start_date=start_date,
                end_date=end_date,
                records_collected=records_count,
                success=(status == "success"),
                error_message=error_message
            )
            session.add(log_entry)
            session.commit()
    
    def get_collection_stats(self) -> Dict[str, Any]:
        """Get statistics about data collection activities."""
        with get_session() as session:
            # Get total records by type
            price_count = session.query(ImbalancePrice).count()
            volume_count = session.query(ImbalanceVolume).count()
            
            # Get recent collection logs
            recent_logs = session.query(DataCollectionLog)\
                .order_by(DataCollectionLog.collection_time.desc())\
                .limit(10)\
                .all()
            
            # Get date range of available data
            price_date_range = session.query(
                ImbalancePrice.timestamp.label('min_date'),
                ImbalancePrice.timestamp.label('max_date')
            ).first() if price_count > 0 else None
            
            volume_date_range = session.query(
                ImbalanceVolume.timestamp.label('min_date'),
                ImbalanceVolume.timestamp.label('max_date')
            ).first() if volume_count > 0 else None
            
            return {
                'total_price_records': price_count,
                'total_volume_records': volume_count,
                'price_date_range': {
                    'min': price_date_range.min_date if price_date_range else None,
                    'max': price_date_range.max_date if price_date_range else None
                } if price_date_range else None,
                'volume_date_range': {
                    'min': volume_date_range.min_date if volume_date_range else None,
                    'max': volume_date_range.max_date if volume_date_range else None
                } if volume_date_range else None,
                'recent_collections': [
                    {
                        'data_type': log.collection_type,
                        'start_date': log.start_date,
                        'end_date': log.end_date,
                        'records_count': log.records_collected,
                        'status': 'success' if log.success else 'error',
                        'created_at': log.collection_time,
                        'error_message': log.error_message
                    }
                    for log in recent_logs
                ]
            }


def main():
    """Test the data collector."""
    collector = DataCollector()
    
    # Test collecting recent data (last 3 days)
    print("Testing data collection for last 3 days...")
    success = collector.collect_recent_data(days_back=3)
    
    if success:
        print("✅ Data collection successful!")
        
        # Show collection statistics
        stats = collector.get_collection_stats()
        print(f"\n📊 Collection Statistics:")
        print(f"Price records: {stats['total_price_records']}")
        print(f"Volume records: {stats['total_volume_records']}")
        
        if stats['recent_collections']:
            print(f"\n📝 Recent Collections:")
            for log in stats['recent_collections'][:3]:
                print(f"- {log['data_type']}: {log['records_count']} records ({log['status']})")
    else:
        print("❌ Data collection failed!")


if __name__ == "__main__":
    main()
