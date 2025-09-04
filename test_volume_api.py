"""
Test script to compare Romanian volume API calls with different parameter formats.
"""

import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
import yaml
from pathlib import Path
import zipfile
import io

# Load configuration
config_path = Path("config.yaml")
with open(config_path, 'r') as f:
    config = yaml.safe_load(f)

def format_datetime(dt: datetime) -> str:
    """Format datetime for ENTSO-E API (yyyyMMddHHmm)."""
    return dt.strftime('%Y%m%d%H%M')

def extract_xml_from_response(response: requests.Response) -> str:
    """Extract XML content from response, handling compressed data."""
    try:
        # Check if response is compressed (ZIP file)
        if response.content.startswith(b'PK'):
            print("Response is compressed, extracting ZIP content")
            with zipfile.ZipFile(io.BytesIO(response.content)) as zip_file:
                # Get the first (and usually only) file in the ZIP
                file_names = zip_file.namelist()
                if not file_names:
                    raise Exception("ZIP file is empty")
                
                xml_content = zip_file.read(file_names[0]).decode('utf-8')
                print(f"Extracted XML from ZIP file: {file_names[0]}")
                return xml_content
        else:
            # Response is plain text/XML
            return response.text
            
    except Exception as e:
        print(f"Failed to extract XML from response: {e}")
        raise

def count_data_points(xml_content: str) -> dict:
    """Count data points and analyze structure in XML response."""
    try:
        root = ET.fromstring(xml_content)
        
        # Check for acknowledgement (no data available)
        if root.find('.//Acknowledgement_MarketDocument') is not None:
            return {"status": "no_data", "message": "No data available for the requested period"}
        
        analysis = {
            "status": "success",
            "timeseries_count": 0,
            "total_points": 0,
            "flow_directions": [],
            "time_periods": [],
            "business_types": []
        }
        
        # Find all TimeSeries elements
        timeseries_elements = root.findall('.//{*}TimeSeries')
        analysis["timeseries_count"] = len(timeseries_elements)
        
        for ts in timeseries_elements:
            # Extract flow direction
            flow_dir = None
            for elem in ts.iter():
                if 'flowDirection.direction' in elem.tag:
                    flow_dir = elem.text
                    if flow_dir not in analysis["flow_directions"]:
                        analysis["flow_directions"].append(flow_dir)
                    break
            
            # Extract business type
            business_type = None
            for elem in ts.iter():
                if 'businessType' in elem.tag:
                    business_type = elem.text
                    if business_type not in analysis["business_types"]:
                        analysis["business_types"].append(business_type)
                    break
            
            # Count points in all periods
            for period in ts.iter():
                if period.tag.endswith('Period'):
                    # Extract time interval
                    start_time = None
                    end_time = None
                    for elem in period.iter():
                        if elem.tag.endswith('start'):
                            start_time = elem.text
                        elif elem.tag.endswith('end'):
                            end_time = elem.text
                    
                    if start_time and end_time:
                        time_period = f"{start_time} to {end_time}"
                        if time_period not in analysis["time_periods"]:
                            analysis["time_periods"].append(time_period)
                    
                    # Count points in this period
                    points = period.findall('.//{*}Point')
                    analysis["total_points"] += len(points)
        
        return analysis
        
    except ET.ParseError as e:
        return {"status": "error", "message": f"Failed to parse XML: {e}"}
    except Exception as e:
        return {"status": "error", "message": f"Error analyzing XML: {e}"}

def test_volume_api_call(param_name: str, domain: str) -> dict:
    """Test volume API call with specific parameter format."""
    
    # Use today's date
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start_date = end_date - timedelta(days=1)
    
    params = {
        'documentType': 'A86',
        param_name: domain,
        'periodStart': format_datetime(start_date),
        'periodEnd': format_datetime(end_date),
        'securityToken': config['api']['token']
    }
    
    print(f"\n=== Testing {param_name} with {domain} ===")
    print(f"Request URL: {config['api']['base_url']}")
    print(f"Parameters: {params}")
    
    try:
        response = requests.get(
            config['api']['base_url'],
            params=params,
            timeout=30
        )
        
        if response.status_code == 200:
            xml_content = extract_xml_from_response(response)
            analysis = count_data_points(xml_content)
            
            print(f"✅ API call successful")
            print(f"Response analysis: {analysis}")
            
            # Save sample XML for inspection
            filename = f"sample_volume_{param_name.lower()}_{domain.replace('-', '_')}.xml"
            with open(filename, 'w', encoding='utf-8') as f:
                f.write(xml_content[:2000] + "\n... (truncated)")
            print(f"Sample XML saved to: {filename}")
            
            return {
                "success": True,
                "status_code": response.status_code,
                "analysis": analysis,
                "xml_sample": xml_content[:500]
            }
        else:
            print(f"❌ API call failed with status {response.status_code}")
            print(f"Response: {response.text}")
            return {
                "success": False,
                "status_code": response.status_code,
                "error": response.text
            }
            
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return {
            "success": False,
            "error": str(e)
        }

def main():
    """Test different parameter formats for Romanian volume data."""
    
    print("🔍 Testing Romanian Volume API Parameter Formats")
    print("=" * 60)
    
    romanian_domain = "10YRO-TEL------P"
    
    # Test 1: Current format (uppercase C)
    result1 = test_volume_api_call("ControlArea_Domain", romanian_domain)
    
    # Test 2: Lowercase format (like Austrian example)
    result2 = test_volume_api_call("controlArea_Domain", romanian_domain)
    
    # Test 3: Try psrType parameter (sometimes needed for volumes)
    print(f"\n=== Testing with psrType parameter ===")
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start_date = end_date - timedelta(days=1)
    
    params_with_psr = {
        'documentType': 'A86',
        'controlArea_Domain': romanian_domain,
        'periodStart': format_datetime(start_date),
        'periodEnd': format_datetime(end_date),
        'psrType': 'A04',  # Try with psrType
        'securityToken': config['api']['token']
    }
    
    try:
        response = requests.get(config['api']['base_url'], params=params_with_psr, timeout=30)
        if response.status_code == 200:
            xml_content = extract_xml_from_response(response)
            analysis = count_data_points(xml_content)
            print(f"✅ psrType test successful: {analysis}")
        else:
            print(f"❌ psrType test failed: {response.status_code}")
    except Exception as e:
        print(f"❌ psrType test error: {e}")
    
    # Summary
    print("\n" + "=" * 60)
    print("📊 SUMMARY")
    print("=" * 60)
    
    if result1["success"] and result1["analysis"]["status"] == "success":
        print(f"ControlArea_Domain (current): {result1['analysis']['total_points']} data points")
        print(f"  - TimeSeries: {result1['analysis']['timeseries_count']}")
        print(f"  - Flow directions: {result1['analysis']['flow_directions']}")
    else:
        print(f"ControlArea_Domain (current): FAILED")
    
    if result2["success"] and result2["analysis"]["status"] == "success":
        print(f"controlArea_Domain (lowercase): {result2['analysis']['total_points']} data points")
        print(f"  - TimeSeries: {result2['analysis']['timeseries_count']}")
        print(f"  - Flow directions: {result2['analysis']['flow_directions']}")
    else:
        print(f"controlArea_Domain (lowercase): FAILED")
    
    # Recommendation
    print("\n🎯 RECOMMENDATION:")
    if result1["success"] and result2["success"]:
        if result1["analysis"]["total_points"] > result2["analysis"]["total_points"]:
            print("Use ControlArea_Domain (uppercase) - provides more data points")
        elif result2["analysis"]["total_points"] > result1["analysis"]["total_points"]:
            print("Use controlArea_Domain (lowercase) - provides more data points")
        else:
            print("Both formats provide similar results - current format is fine")
    elif result2["success"] and not result1["success"]:
        print("Switch to controlArea_Domain (lowercase) - current format fails")
    elif result1["success"] and not result2["success"]:
        print("Keep ControlArea_Domain (uppercase) - lowercase format fails")
    else:
        print("Both formats failed - investigate other parameters or API issues")

if __name__ == "__main__":
    main()
