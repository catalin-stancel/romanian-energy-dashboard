"""
ENTSO-E Transparency Platform API Client for Romanian Energy Balancing Market Data.
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


class ENTSOEClient:
    """Client for interacting with ENTSO-E Transparency Platform API."""
    
    def __init__(self):
        self.base_url = config['api']['base_url']
        self.token = config['api']['token']
        self.domain = config['market']['domain']
        self.rate_limit = config['api']['rate_limit']
        self.timeout = config['api']['timeout']
        self.last_request_time = 0
        self.request_count = 0
        self.request_window_start = time.time()
        
        # XML namespaces for ENTSO-E documents
        self.ns = {
            'ns': 'urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:0',
            'bal': 'urn:iec62325.351:tc57wg16:451-6:balancingdocument:4:4',
            'bal3': 'urn:iec62325.351:tc57wg16:451-6:balancingdocument:3:0'
        }
        
        logger.info(f"Initialized ENTSO-E client for domain: {self.domain}")
    
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

    def _parse_xml_response(self, xml_content: str) -> List[Dict]:
        """Parse XML response from ENTSO-E API."""
        try:
            # Debug: log first 500 characters of response
            logger.debug(f"XML Response (first 500 chars): {xml_content[:500]}")
            
            root = ET.fromstring(xml_content)
            
            # Check for acknowledgement (no data available)
            if root.find('.//ns:Acknowledgement_MarketDocument', self.ns) is not None:
                logger.info("No data available for the requested period")
                return []
            
            data_points = []
            
            # Try different namespaces for balancing documents
            namespaces_to_try = [
                ('bal', 'urn:iec62325.351:tc57wg16:451-6:balancingdocument:4:4'),
                ('bal3', 'urn:iec62325.351:tc57wg16:451-6:balancingdocument:3:0'),
                ('ns', 'urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:0')
            ]
            
            # Detect the correct namespace from the root element
            root_namespace = root.tag.split('}')[0][1:] if '}' in root.tag else None
            current_ns = {'ns': root_namespace} if root_namespace else self.ns
            
            # Find all TimeSeries elements (try different possible paths)
            timeseries_elements = (
                root.findall('.//TimeSeries') or  # No namespace
                root.findall('.//{*}TimeSeries') or  # Any namespace
                root.findall('.//ns:TimeSeries', current_ns)  # Specific namespace
            )
            
            for timeseries in timeseries_elements:
                # Extract metadata (try with and without namespace)
                business_type = None
                for elem in timeseries.iter():
                    if elem.tag.endswith('businessType') or elem.tag == 'businessType':
                        business_type = elem.text
                        break
                
                price_category = None
                for elem in timeseries.iter():
                    if 'imbalance_Price.category' in elem.tag or elem.tag == 'imbalance_Price.category':
                        price_category = elem.text
                        break
                
                currency = None
                for elem in timeseries.iter():
                    if 'currency_Unit.name' in elem.tag or elem.tag == 'currency_Unit.name':
                        currency = elem.text
                        break
                
                measure_unit = None
                for elem in timeseries.iter():
                    if 'price_Measure_Unit.name' in elem.tag or elem.tag == 'price_Measure_Unit.name':
                        measure_unit = elem.text
                        break
                    elif 'quantity_Measure_Unit.name' in elem.tag or elem.tag == 'quantity_Measure_Unit.name':
                        measure_unit = elem.text
                        break
                
                # Find Period element
                period = None
                for elem in timeseries.iter():
                    if elem.tag.endswith('Period') or elem.tag == 'Period':
                        period = elem
                        break
                
                if period is None:
                    continue
                
                # Extract time interval
                start_time = None
                end_time = None
                for elem in period.iter():
                    if elem.tag.endswith('start') or elem.tag == 'start':
                        start_time = elem.text
                    elif elem.tag.endswith('end') or elem.tag == 'end':
                        end_time = elem.text
                
                if not start_time:
                    continue
                
                # Extract resolution
                resolution = None
                for elem in period.iter():
                    if elem.tag.endswith('resolution') or elem.tag == 'resolution':
                        resolution = elem.text
                        break
                
                # Parse resolution to get minutes
                resolution_minutes = 60  # Default
                if resolution == 'PT15M':
                    resolution_minutes = 15
                elif resolution == 'PT60M':
                    resolution_minutes = 60
                
                # Convert start time to datetime (ENTSO-E returns UTC time)
                try:
                    start_dt_utc = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                    # Convert UTC to Romanian time (UTC+3)
                    romanian_tz = pytz.timezone('Europe/Bucharest')
                    start_dt = start_dt_utc.astimezone(romanian_tz).replace(tzinfo=None)  # Store as naive datetime in local time
                except:
                    continue
                
                # Extract all points
                for point_elem in period.iter():
                    if point_elem.tag.endswith('Point') or point_elem.tag == 'Point':
                        position = None
                        value = None
                        
                        # Extract position and value from Point
                        for child in point_elem:
                            if child.tag.endswith('position') or child.tag == 'position':
                                position = int(child.text)
                            elif child.tag.endswith('price.amount') or child.tag == 'price.amount':
                                value = float(child.text)
                            elif child.tag.endswith('imbalance_Price.amount') or child.tag == 'imbalance_Price.amount':
                                value = float(child.text)
                            elif child.tag.endswith('quantity') or child.tag == 'quantity':
                                value = float(child.text)
                        
                        if position is not None and value is not None:
                            # Calculate timestamp for this point (already in Romanian time)
                            point_dt = start_dt + timedelta(minutes=(position - 1) * resolution_minutes)
                            
                            data_points.append({
                                'timestamp': point_dt,
                                'value': value,
                                'business_type': business_type,
                                'price_category': price_category,
                                'currency': currency,
                                'measure_unit': measure_unit,
                                'resolution_minutes': resolution_minutes
                            })
            
            logger.info(f"Parsed {len(data_points)} data points from XML response")
            return data_points
            
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML response: {e}")
            raise
        except Exception as e:
            logger.error(f"Error parsing XML response: {e}")
            raise
    
    def get_imbalance_prices(self, 
                           start_date: datetime, 
                           end_date: datetime,
                           price_category: Optional[str] = None) -> pd.DataFrame:
        """
        Fetch imbalance prices for Romanian market.
        
        Args:
            start_date: Start date for data retrieval
            end_date: End date for data retrieval
            price_category: Specific price category (A04, A05, etc.)
        
        Returns:
            DataFrame with imbalance price data
        """
        params = {
            'documentType': config['document_types']['imbalance_prices'],
            'ControlArea_Domain': self.domain,  # Correct parameter name
            'periodStart': self._format_datetime(start_date),
            'periodEnd': self._format_datetime(end_date)
        }
        
        if price_category:
            params['imbalance_Price.category'] = price_category
        
        logger.info(f"Fetching imbalance prices from {start_date} to {end_date}")
        
        try:
            response = self._make_request(params)
            xml_content = self._extract_xml_from_response(response)
            data_points = self._parse_xml_response(xml_content)
            
            if not data_points:
                logger.warning("No imbalance price data found for the specified period")
                return pd.DataFrame()
            
            df = pd.DataFrame(data_points)
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            # Rename 'value' column to 'price' for consistency with dashboard expectations
            if 'value' in df.columns:
                df = df.rename(columns={'value': 'price'})
            df = df.sort_values('timestamp').reset_index(drop=True)
            
            logger.info(f"Retrieved {len(df)} imbalance price records")
            return df
            
        except Exception as e:
            logger.error(f"Failed to fetch imbalance prices: {e}")
            raise
    
    def get_imbalance_volumes(self, 
                            start_date: datetime, 
                            end_date: datetime) -> pd.DataFrame:
        """
        Fetch imbalance volumes for Romanian market.
        
        Args:
            start_date: Start date for data retrieval
            end_date: End date for data retrieval
        
        Returns:
            DataFrame with imbalance volume data
        """
        params = {
            'documentType': config['document_types']['imbalance_volumes'],
            'ControlArea_Domain': self.domain,  # Correct parameter name
            'periodStart': self._format_datetime(start_date),
            'periodEnd': self._format_datetime(end_date)
        }
        
        logger.info(f"Fetching imbalance volumes from {start_date} to {end_date}")
        
        try:
            response = self._make_request(params)
            xml_content = self._extract_xml_from_response(response)
            data_points = self._parse_xml_response(xml_content)
            
            if not data_points:
                logger.warning("No imbalance volume data found for the specified period")
                return pd.DataFrame()
            
            df = pd.DataFrame(data_points)
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            df = df.sort_values('timestamp').reset_index(drop=True)
            
            logger.info(f"Retrieved {len(df)} imbalance volume records")
            return df
            
        except Exception as e:
            logger.error(f"Failed to fetch imbalance volumes: {e}")
            raise
    
    def get_latest_data(self, hours_back: int = 24) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Get the latest imbalance prices and volumes.
        
        Args:
            hours_back: Number of hours back from now to fetch data
        
        Returns:
            Tuple of (prices_df, volumes_df)
        """
        end_date = datetime.now()
        start_date = end_date - timedelta(hours=hours_back)
        
        logger.info(f"Fetching latest data for the last {hours_back} hours")
        
        try:
            prices_df = self.get_imbalance_prices(start_date, end_date)
            volumes_df = self.get_imbalance_volumes(start_date, end_date)
            
            return prices_df, volumes_df
            
        except Exception as e:
            logger.error(f"Failed to fetch latest data: {e}")
            raise
    
    def test_connection(self) -> bool:
        """Test API connection and authentication."""
        try:
            logger.info("Testing ENTSO-E API connection...")
            
            # Try to fetch data from yesterday (imbalance data has publication delay)
            end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            start_date = end_date - timedelta(days=1)
            
            prices_df = self.get_imbalance_prices(start_date, end_date)
            
            logger.info("API connection test successful")
            return True
            
        except Exception as e:
            logger.error(f"API connection test failed: {e}")
            return False


if __name__ == "__main__":
    # Test the client
    client = ENTSOEClient()
    
    if client.test_connection():
        print("✅ ENTSO-E API client is working correctly!")
        
        # Fetch some sample data
        prices_df, volumes_df = client.get_latest_data(hours_back=6)
        
        print(f"\n📊 Sample Data Retrieved:")
        print(f"Prices: {len(prices_df)} records")
        print(f"Volumes: {len(volumes_df)} records")
        
        if not prices_df.empty:
            print(f"\n💰 Latest Price Data:")
            print(prices_df.tail())
        
        if not volumes_df.empty:
            print(f"\n📈 Latest Volume Data:")
            print(volumes_df.tail())
    else:
        print("❌ ENTSO-E API client test failed!")
