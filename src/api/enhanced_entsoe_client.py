"""
Enhanced ENTSO-E Transparency Platform API Client with bidirectional volume support.
"""

import requests
import xml.etree.ElementTree as ET
import pandas as pd
from datetime import datetime, timedelta
import time
import logging
from typing import Dict, List, Optional, Tuple
import yaml
from pathlib import Path
import zipfile
import io
import pytz

# Load configuration
config_path = Path(__file__).parent.parent.parent / "config.yaml"
with open(config_path, 'r') as f:
    config = yaml.safe_load(f)

# Set up logging
logging.basicConfig(
    level=getattr(logging, config['logging']['level']),
    format=config['logging']['format']
)
logger = logging.getLogger(__name__)


class EnhancedENTSOEClient:
    """Enhanced client for ENTSO-E API with bidirectional volume support."""
    
    def __init__(self):
        self.base_url = config['api']['base_url']
        self.token = config['api']['token']
        self.domain = config['market']['domain']
        self.rate_limit = config['api']['rate_limit']
        self.timeout = config['api']['timeout']
        self.last_request_time = 0
        self.request_count = 0
        self.request_window_start = time.time()
        
        logger.info(f"Initialized Enhanced ENTSO-E client for domain: {self.domain}")
    
    def _rate_limit_check(self):
        """Ensure we don't exceed API rate limits."""
        current_time = time.time()
        
        # Reset counter every minute
        if current_time - self.request_window_start >= 60:
            self.request_count = 0
            self.request_window_start = current_time
        
        # Check if we're approaching rate limit
        if self.request_count >= self.rate_limit - 10:  # Leave some buffer
            sleep_time = 60 - (current_time - self.request_window_start)
            if sleep_time > 0:
                logger.warning(f"Rate limit approaching, sleeping for {sleep_time:.2f} seconds")
                time.sleep(sleep_time)
                self.request_count = 0
                self.request_window_start = time.time()
        
        # Ensure minimum time between requests
        time_since_last = current_time - self.last_request_time
        if time_since_last < 0.2:  # Max 5 requests per second
            time.sleep(0.2 - time_since_last)
        
        self.last_request_time = time.time()
        self.request_count += 1
    
    def _format_datetime(self, dt: datetime) -> str:
        """Format datetime for ENTSO-E API (yyyyMMddHHmm)."""
        return dt.strftime('%Y%m%d%H%M')
    
    def _make_request(self, params: Dict) -> requests.Response:
        """Make API request with error handling and retries."""
        params['securityToken'] = self.token
        
        for attempt in range(config['data_collection']['retry_attempts']):
            try:
                self._rate_limit_check()
                
                logger.debug(f"Making API request (attempt {attempt + 1}): {params}")
                response = requests.get(
                    self.base_url,
                    params=params,
                    timeout=self.timeout
                )
                
                if response.status_code == 200:
                    logger.debug("API request successful")
                    return response
                elif response.status_code == 429:  # Rate limit exceeded
                    logger.warning("Rate limit exceeded, waiting before retry")
                    time.sleep(60)
                    continue
                else:
                    logger.error(f"API request failed with status {response.status_code}: {response.text}")
                    response.raise_for_status()
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request attempt {attempt + 1} failed: {e}")
                if attempt < config['data_collection']['retry_attempts'] - 1:
                    time.sleep(config['data_collection']['retry_delay_seconds'])
                else:
                    raise
        
        raise Exception("All retry attempts failed")
    
    def _extract_xml_from_response(self, response: requests.Response) -> str:
        """Extract XML content from response, handling compressed data."""
        try:
            # Check if response is compressed (ZIP file)
            if response.content.startswith(b'PK'):
                logger.debug("Response is compressed, extracting ZIP content")
                with zipfile.ZipFile(io.BytesIO(response.content)) as zip_file:
                    # Get the first (and usually only) file in the ZIP
                    file_names = zip_file.namelist()
                    if not file_names:
                        raise Exception("ZIP file is empty")
                    
                    xml_content = zip_file.read(file_names[0]).decode('utf-8')
                    logger.debug(f"Extracted XML from ZIP file: {file_names[0]}")
                    return xml_content
            else:
                # Response is plain text/XML
                return response.text
                
        except Exception as e:
            logger.error(f"Failed to extract XML from response: {e}")
            raise

    def _parse_volume_xml_response(self, xml_content: str) -> List[Dict]:
        """Parse volume XML response with bidirectional flow support."""
        try:
            logger.debug(f"XML Response (first 500 chars): {xml_content[:500]}")
            
            root = ET.fromstring(xml_content)
            
            # Check for acknowledgement (no data available)
            if root.find('.//Acknowledgement_MarketDocument') is not None:
                logger.info("No data available for the requested period")
                return []
            
            data_points = []
            
            # Find all TimeSeries elements
            timeseries_elements = root.findall('.//{*}TimeSeries')
            logger.info(f"Found {len(timeseries_elements)} TimeSeries in volume response")
            
            for ts_idx, timeseries in enumerate(timeseries_elements):
                # Extract flow direction
                flow_direction = None
                for elem in timeseries.iter():
                    if 'flowDirection.direction' in elem.tag:
                        flow_direction = elem.text
                        break
                
                # Extract business type
                business_type = None
                for elem in timeseries.iter():
                    if 'businessType' in elem.tag:
                        business_type = elem.text
                        break
                
                # Extract measure unit
                measure_unit = None
                for elem in timeseries.iter():
                    if 'quantity_Measure_Unit.name' in elem.tag:
                        measure_unit = elem.text
                        break
                
                logger.debug(f"TimeSeries {ts_idx + 1}: flow_direction={flow_direction}, business_type={business_type}")
                
                # Find all Period elements in this TimeSeries
                periods = timeseries.findall('.//{*}Period')
                logger.debug(f"Found {len(periods)} periods in TimeSeries {ts_idx + 1}")
                
                for period_idx, period in enumerate(periods):
                    # Extract time interval
                    start_time = None
                    end_time = None
                    for elem in period.iter():
                        if elem.tag.endswith('start'):
                            start_time = elem.text
                        elif elem.tag.endswith('end'):
                            end_time = elem.text
                    
                    if not start_time:
                        continue
                    
                    # Extract resolution
                    resolution = None
                    for elem in period.iter():
                        if elem.tag.endswith('resolution'):
                            resolution = elem.text
                            break
                    
                    # Parse resolution to get minutes
                    resolution_minutes = 15  # Default for PT15M
                    if resolution == 'PT60M':
                        resolution_minutes = 60
                    
                    # Convert start time to datetime (ENTSO-E returns UTC time)
                    try:
                        start_dt_utc = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                        # Convert UTC to Romanian time (UTC+3)
                        romanian_tz = pytz.timezone('Europe/Bucharest')
                        start_dt = start_dt_utc.astimezone(romanian_tz).replace(tzinfo=None)
                    except Exception as e:
                        logger.warning(f"Failed to parse start time {start_time}: {e}")
                        continue
                    
                    # Extract all points in this period
                    points = period.findall('.//{*}Point')
                    logger.debug(f"Period {period_idx + 1} ({start_time} to {end_time}): {len(points)} points")
                    
                    for point in points:
                        position = None
                        quantity = None
                        
                        # Extract position and quantity from Point
                        for child in point:
                            if child.tag.endswith('position'):
                                position = int(child.text)
                            elif child.tag.endswith('quantity'):
                                quantity = float(child.text)
                        
                        if position is not None and quantity is not None:
                            # Calculate timestamp for this point
                            point_dt = start_dt + timedelta(minutes=(position - 1) * resolution_minutes)
                            
                            data_points.append({
                                'timestamp': point_dt,
                                'value': quantity,
                                'flow_direction': flow_direction,
                                'business_type': business_type,
                                'measure_unit': measure_unit,
                                'resolution_minutes': resolution_minutes
                            })
            
            logger.info(f"Parsed {len(data_points)} volume data points from XML response")
            return data_points
            
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML response: {e}")
            raise
        except Exception as e:
            logger.error(f"Error parsing XML response: {e}")
            raise
    
    def get_enhanced_imbalance_volumes(self, 
                                     start_date: datetime, 
                                     end_date: datetime) -> pd.DataFrame:
        """
        Fetch enhanced imbalance volumes with bidirectional flow data.
        
        Args:
            start_date: Start date for data retrieval
            end_date: End date for data retrieval
        
        Returns:
            DataFrame with enhanced volume data including flow directions
        """
        params = {
            'documentType': config['document_types']['imbalance_volumes'],
            'ControlArea_Domain': self.domain,
            'periodStart': self._format_datetime(start_date),
            'periodEnd': self._format_datetime(end_date)
        }
        
        logger.info(f"Fetching enhanced imbalance volumes from {start_date} to {end_date}")
        
        try:
            response = self._make_request(params)
            xml_content = self._extract_xml_from_response(response)
            data_points = self._parse_volume_xml_response(xml_content)
            
            if not data_points:
                logger.warning("No imbalance volume data found for the specified period")
                return pd.DataFrame()
            
            df = pd.DataFrame(data_points)
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            df = df.sort_values(['timestamp', 'flow_direction']).reset_index(drop=True)
            
            logger.info(f"Retrieved {len(df)} enhanced imbalance volume records")
            
            # Log flow direction distribution
            if 'flow_direction' in df.columns:
                flow_counts = df['flow_direction'].value_counts()
                logger.info(f"Flow direction distribution: {flow_counts.to_dict()}")
            
            return df
            
        except Exception as e:
            logger.error(f"Failed to fetch enhanced imbalance volumes: {e}")
            raise
    
    def calculate_net_imbalance_volumes(self, volumes_df: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate net imbalance volumes and deficit/surplus status.
        
        Args:
            volumes_df: DataFrame with bidirectional volume data
        
        Returns:
            DataFrame with net volumes and status
        """
        if volumes_df.empty:
            return pd.DataFrame()
        
        logger.info("Calculating net imbalance volumes and deficit/surplus status")
        
        # Pivot to get import (A01) and export (A02) volumes by timestamp
        pivot_df = volumes_df.pivot_table(
            index='timestamp',
            columns='flow_direction',
            values='value',
            aggfunc='sum',
            fill_value=0
        ).reset_index()
        
        # Ensure we have both A01 and A02 columns
        if 'A01' not in pivot_df.columns:
            pivot_df['A01'] = 0  # Import volumes
        if 'A02' not in pivot_df.columns:
            pivot_df['A02'] = 0  # Export volumes
        
        # Calculate net imbalance (Import - Export)
        # Positive = Surplus (more import than export)
        # Negative = Deficit (more export than import)
        pivot_df['net_volume'] = pivot_df['A01'] - pivot_df['A02']
        
        # Determine status based on net volume
        def determine_status(net_vol):
            if abs(net_vol) < 5:  # Threshold for "balanced" (5 MWh)
                return 'Balanced'
            elif net_vol > 0:
                return 'Surplus'
            else:
                return 'Deficit'
        
        pivot_df['status'] = pivot_df['net_volume'].apply(determine_status)
        
        # Rename columns for clarity
        pivot_df = pivot_df.rename(columns={
            'A01': 'import_volume',
            'A02': 'export_volume'
        })
        
        # Add measure unit (assuming MWH from the XML)
        pivot_df['measure_unit'] = 'MWH'
        
        logger.info(f"Calculated net volumes for {len(pivot_df)} timestamps")
        
        # Log status distribution
        status_counts = pivot_df['status'].value_counts()
        logger.info(f"Status distribution: {status_counts.to_dict()}")
        
        return pivot_df[['timestamp', 'import_volume', 'export_volume', 'net_volume', 'status', 'measure_unit']]


def test_enhanced_client():
    """Test the enhanced client with bidirectional volume data."""
    client = EnhancedENTSOEClient()
    
    # Test with today's data
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start_date = end_date - timedelta(days=1)
    
    print(f"🔍 Testing Enhanced Volume Collection")
    print(f"Period: {start_date} to {end_date}")
    print("=" * 60)
    
    try:
        # Get enhanced volume data
        volumes_df = client.get_enhanced_imbalance_volumes(start_date, end_date)
        
        if not volumes_df.empty:
            print(f"✅ Retrieved {len(volumes_df)} volume records")
            print(f"Flow directions: {volumes_df['flow_direction'].unique()}")
            print(f"Time range: {volumes_df['timestamp'].min()} to {volumes_df['timestamp'].max()}")
            
            # Calculate net volumes
            net_volumes_df = client.calculate_net_imbalance_volumes(volumes_df)
            
            if not net_volumes_df.empty:
                print(f"\n📊 Net Volume Analysis:")
                print(f"Records with net volumes: {len(net_volumes_df)}")
                print(f"Status distribution:")
                for status, count in net_volumes_df['status'].value_counts().items():
                    print(f"  - {status}: {count} intervals")
                
                # Show sample data
                print(f"\n📈 Sample Net Volume Data:")
                sample_df = net_volumes_df.head(10)
                for _, row in sample_df.iterrows():
                    print(f"  {row['timestamp'].strftime('%H:%M')}: Import={row['import_volume']:.1f}, Export={row['export_volume']:.1f}, Net={row['net_volume']:.1f} MWH -> {row['status']}")
            else:
                print("❌ No net volume data calculated")
        else:
            print("❌ No volume data retrieved")
            
    except Exception as e:
        print(f"❌ Test failed: {e}")


if __name__ == "__main__":
    test_enhanced_client()
