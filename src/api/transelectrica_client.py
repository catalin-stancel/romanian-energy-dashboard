"""
Transelectrica API client for fetching Romanian power generation and consumption data.
"""

import requests
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Optional, List, Tuple
import time
import re

logger = logging.getLogger(__name__)


class TranselectricaClient:
    """Client for fetching data from Transelectrica's real-time power system."""
    
    def __init__(self):
        self.base_url = "https://www.transelectrica.ro/sen-filter"
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',  # Remove 'br' to avoid Brotli compression issues
            'Connection': 'keep-alive',
            'X-Requested-With': 'XMLHttpRequest',
            # Cache-breaking headers
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        })
        
        # Mapping of JSON keys to our database fields
        self.generation_mapping = {
            'nuclear': ['NUCL', 'NUCL15'],
            'coal': ['CARB', 'CARB15'],
            'gas': ['GAZE', 'GAZE15'],
            'wind': ['EOLIAN', 'EOLIAN15'],
            'hydro': ['APE'],
            'solar': ['FOTO', 'FOTO15'],
        }
        
        # Interconnection mappings (negative values = imports, positive = exports)
        self.interconnection_mapping = {
            'interconnection_hungary': ['DOBR', 'DOBR15'],
            'interconnection_bulgaria': ['VARN', 'VARN15'],
            'interconnection_serbia': ['VULC'],
        }
        
        # Live border IDs (only these count for SOLD) - 18 border points
        self.LIVE_BORDER_IDS = [
            "MUKA", "ISPOZ", "IS", "UNGE", "CIOA", "GOTE", "VULC", "DOBR", "VARN",
            "KOZL1", "KOZL2", "DJER", "SIP_", "PANCEVO21", "PANCEVO22", "KIKI", "SAND", "BEKE1"
        ]
        
        # Specific power generation units for imports/exports tracking (18 border points)
        self.import_export_units_mapping = {
            'unit_muka': ['MUKA'],
            'unit_ispoz': ['ISPOZ'],
            'unit_is': ['IS'],
            'unit_unge': ['UNGE'],
            'unit_cioa': ['CIOA'],
            'unit_gote': ['GOTE'],
            'unit_vulc': ['VULC'],
            'unit_dobr': ['DOBR'],
            'unit_varn': ['VARN'],
            'unit_kozl1': ['KOZL1'],
            'unit_kozl2': ['KOZL2'],
            'unit_djer': ['DJER'],
            'unit_sip': ['SIP_'],
            'unit_pancevo21': ['PANCEVO21'],
            'unit_pancevo22': ['PANCEVO22'],
            'unit_kiki': ['KIKI'],
            'unit_sand': ['SAND'],
            'unit_beke1': ['BEKE1'],
            'unit_beke115': ['BEKE115'],
        }
    
    def _generate_cache_buster(self) -> str:
        """Generate cache buster parameter."""
        return str(int(time.time() * 1000))
    
    def _parse_timestamp(self, timestamp_str: str) -> Optional[datetime]:
        """
        Parse Romanian timestamp format to UTC datetime.
        Expected format: "25/8/18 19:12:22" (DD/M/YY HH:MM:SS)
        """
        try:
            # Handle various date formats
            patterns = [
                r'(\d{1,2})/(\d{1,2})/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})',  # DD/M/YY HH:MM:SS
                r'(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})',  # DD/M/YYYY HH:MM:SS
            ]
            
            for pattern in patterns:
                match = re.match(pattern, timestamp_str.strip())
                if match:
                    day, month, year, hour, minute, second = match.groups()
                    
                    # Convert 2-digit year to 4-digit
                    year = int(year)
                    if year < 50:  # Assume years 00-49 are 2000-2049
                        year += 2000
                    elif year < 100:  # Assume years 50-99 are 1950-1999
                        year += 1900
                    
                    # Create datetime in Romanian timezone (Europe/Bucharest)
                    dt = datetime(
                        year=year,
                        month=int(month),
                        day=int(day),
                        hour=int(hour),
                        minute=int(minute),
                        second=int(second)
                    )
                    
                    # Convert to UTC (Romania is UTC+2/UTC+3 depending on DST)
                    # For simplicity, we'll assume UTC+2 (EET) - this could be enhanced
                    # to properly handle DST transitions
                    from datetime import timedelta
                    dt_utc = dt - timedelta(hours=2)
                    dt_utc = dt_utc.replace(tzinfo=timezone.utc)
                    
                    return dt_utc
            
            logger.warning(f"Could not parse timestamp: {timestamp_str}")
            return None
            
        except Exception as e:
            logger.error(f"Error parsing timestamp '{timestamp_str}': {e}")
            return None
    
    def _extract_value(self, data: List[Dict], keys: List[str]) -> float:
        """Extract and sum values for given keys from the data."""
        total = 0.0
        for item in data:
            for key in keys:
                if key in item:
                    try:
                        value = float(item[key])
                        total += value
                    except (ValueError, TypeError):
                        continue
        return total
    
    def _find_timestamp(self, data: List[Dict]) -> Optional[datetime]:
        """Find timestamp in the data."""
        for item in data:
            for key, value in item.items():
                if 'DATA' in key.upper() and isinstance(value, str):
                    return self._parse_timestamp(value)
        return None
    
    def _to_dict(self, feed: List[Dict]) -> Dict[str, int]:
        """
        Convert JSON feed (list of {k:v}) to dict and coerce numeric strings to int.
        Handles commas in numeric values and strips whitespace.
        """
        d = {}
        for item in feed:
            d.update(item)
        
        # Coerce numeric strings to int, keep non-numerics as-is
        out = {}
        for k, v in d.items():
            try:
                # Handle numeric strings with commas and whitespace
                if isinstance(v, str):
                    cleaned_value = str(v).replace(',', '').strip()
                    out[k] = int(cleaned_value)
                else:
                    out[k] = int(v)
            except (ValueError, TypeError):
                out[k] = v
        return out
    
    def _calculate_border_flows(self, feed: List[Dict]) -> Dict[str, any]:
        """
        Calculate imports/exports from the 18 live border points.
        Uses the correct algorithm that matches SOLD values in the feed.
        """
        d = self._to_dict(feed)
        
        # Get values for all 18 live border IDs
        vals = [d.get(k, 0) for k in self.LIVE_BORDER_IDS]
        
        # Calculate imports and exports correctly
        imports = sum(v for v in vals if v > 0)
        exports = sum(-v for v in vals if v < 0)  # absolute value of negatives
        net = imports - exports  # (+) = net import
        
        # Get SOLD value from feed for validation
        sold_feed = d.get("SOLD")
        
        # Create detailed border point breakdown
        border_details = {}
        for border_id in self.LIVE_BORDER_IDS:
            value = d.get(border_id, 0)
            border_details[border_id] = value
        
        return {
            "imports": imports,
            "exports": exports,
            "net": net,
            "SOLD_in_feed": sold_feed,
            "matches_SOLD": (sold_feed == net) if isinstance(sold_feed, int) else None,
            "border_details": border_details,
            "border_values": vals
        }
    
    def fetch_power_data(self) -> Optional[Dict]:
        """
        Fetch current power generation and consumption data.
        
        Returns:
            Dict with parsed power data or None if failed
        """
        try:
            # Generate multiple cache busters for maximum freshness
            cache_buster = self._generate_cache_buster()
            
            # Additional cache-breaking parameters
            params = {
                '_': cache_buster,
                'nocache': cache_buster,
                'timestamp': int(time.time()),
                'rand': int(time.time() * 1000) % 999999
            }
            
            # Additional cache-breaking headers for this request
            headers = {
                'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0',
                'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT',
                'If-None-Match': '*'
            }
            
            # Make request with aggressive cache-breaking
            logger.debug(f"Fetching data from: {self.base_url} with params: {params}")
            
            response = self.session.get(
                self.base_url, 
                params=params,
                headers=headers,
                timeout=30
            )
            response.raise_for_status()
            
            # Debug: log response content
            logger.debug(f"Response status: {response.status_code}")
            logger.debug(f"Response headers: {dict(response.headers)}")
            logger.debug(f"Response content (first 500 chars): {response.text[:500]}")
            
            # Parse JSON response
            if not response.text.strip():
                logger.error("Empty response received")
                return None
                
            data = response.json()
            logger.debug(f"Received {len(data)} data items")
            
            # Extract timestamp
            timestamp = self._find_timestamp(data)
            if not timestamp:
                logger.warning("Could not find timestamp in response")
                timestamp = datetime.now(timezone.utc)
            
            # Extract generation data
            generation_data = {}
            for source, keys in self.generation_mapping.items():
                value = self._extract_value(data, keys)
                generation_data[source] = value
            
            # Extract interconnection data
            interconnection_data = {}
            for connection, keys in self.interconnection_mapping.items():
                value = self._extract_value(data, keys)
                interconnection_data[connection] = value
            
            # Calculate correct border flows using the proven algorithm
            border_flows = self._calculate_border_flows(data)
            
            # Extract specific import/export units data (for backward compatibility)
            import_export_units_data = {}
            for unit, keys in self.import_export_units_mapping.items():
                # Look for the actual keys in the API response (like 'MUKA', 'ISPOZ', etc.)
                value = self._extract_value(data, keys)
                import_export_units_data[unit] = value
            
            # Extract totals using correct data sources
            total_production = self._extract_value(data, ['PROD'])
            total_consumption = self._extract_value(data, ['CONS'])
            
            # Use the correct border flow calculations from live data
            imports_total = border_flows["imports"]
            exports_total = border_flows["exports"]
            total_import_export_units = border_flows["net"]
            
            # Get SOLD value for verification
            sold_value = border_flows["SOLD_in_feed"] or 0
            
            # Log system balance information for verification
            system_balance = total_production - total_consumption
            total_balance = (total_production + imports_total) - (total_consumption + exports_total)
            
            logger.info(f"📊 Live Border Data: Imports={imports_total} MW, Exports={exports_total} MW, Net={total_import_export_units} MW")
            logger.info(f"📊 System Balance: Production-Consumption={system_balance:.0f} MW, SOLD={sold_value} MW")
            logger.info(f"📊 Total Balance: (Prod+Imports)-(Cons+Exports)={total_balance:.0f} MW")
            
            # Verification: total balance should be close to 0
            if abs(total_balance) < 10:
                logger.info(f"✅ System balanced: Total balance = {total_balance:.0f} MW")
            else:
                logger.warning(f"⚠️ System imbalance: Total balance = {total_balance:.0f} MW")
            
            # Calculate net balance as production - consumption
            net_balance = total_production - total_consumption
            
            # Calculate other generation (production not accounted for by main sources)
            accounted_generation = sum(generation_data.values())
            other_generation = max(0, total_production - accounted_generation)
            generation_data['other'] = other_generation
            
            result = {
                'timestamp': timestamp,
                'generation': generation_data,
                'totals': {
                    'production': total_production,
                    'consumption': total_consumption,
                    'net_balance': net_balance,
                    'imports': imports_total,
                    'exports': exports_total
                },
                'interconnections': interconnection_data,
                'import_export_units': import_export_units_data,
                'total_import_export_units': total_import_export_units,
                'imports_total': imports_total,
                'exports_total': exports_total,
                'raw_data': json.dumps(data)
            }
            
            logger.info(f"Successfully fetched power data: {total_production:.0f}MW production, {total_consumption:.0f}MW consumption")
            return result
            
        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP error fetching power data: {e}")
            return None
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error fetching power data: {e}")
            return None
    
    def test_connection(self) -> bool:
        """Test connection to Transelectrica API."""
        try:
            data = self.fetch_power_data()
            return data is not None
        except Exception as e:
            logger.error(f"Connection test failed: {e}")
            return False


if __name__ == "__main__":
    # Test the client
    logging.basicConfig(level=logging.DEBUG)
    
    client = TranselectricaClient()
    
    print("Testing Transelectrica API client...")
    
    # Test connection
    if client.test_connection():
        print("✅ Connection test passed")
    else:
        print("❌ Connection test failed")
        exit(1)
    
    # Fetch and display data
    data = client.fetch_power_data()
    if data:
        print(f"\n📊 Power Data at {data['timestamp']}:")
        print(f"Production: {data['totals']['production']:.0f} MW")
        print(f"Consumption: {data['totals']['consumption']:.0f} MW")
        print(f"Net Balance: {data['totals']['net_balance']:.0f} MW")
        
        print("\n🏭 Generation by Source:")
        for source, value in data['generation'].items():
            if value > 0:
                print(f"  {source.capitalize()}: {value:.0f} MW")
        
        print("\n🔌 Interconnections:")
        for connection, value in data['interconnections'].items():
            if abs(value) > 0:
                direction = "export" if value > 0 else "import"
                print(f"  {connection.replace('interconnection_', '').capitalize()}: {abs(value):.0f} MW ({direction})")
    else:
        print("❌ Failed to fetch data")
