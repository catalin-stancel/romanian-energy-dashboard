#!/usr/bin/env python3
"""
Deploy to Vercel using direct API - No CLI required!
"""

import os
import sys
import json
import time
import requests
import zipfile
import tempfile
from pathlib import Path

class VercelDeployer:
    def __init__(self):
        self.api_url = "https://api.vercel.com"
        self.token = None
        self.headers = {}
        
    def get_vercel_token(self):
        """Get Vercel token from user or environment"""
        token = os.getenv("VERCEL_TOKEN")
        if not token:
            print("🔑 Vercel Token Required")
            print("1. Go to https://vercel.com/account/tokens")
            print("2. Create a new token")
            print("3. Enter it below:")
            token = input("Vercel Token: ").strip()
            
            if not token:
                print("❌ Token is required")
                return False
        
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        return True
    
    def test_vercel_connection(self):
        """Test Vercel API connection"""
        try:
            response = requests.get(f"{self.api_url}/v2/user", headers=self.headers)
            if response.status_code == 200:
                user_data = response.json()
                print(f"✅ Connected to Vercel as: {user_data.get('name', 'Unknown')}")
                return True
            else:
                print(f"❌ Failed to connect to Vercel: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ Connection error: {e}")
            return False
    
    def create_vercel_json(self):
        """Create vercel.json configuration"""
        vercel_config = {
            "version": 2,
            "name": "romanian-energy-dashboard",
            "builds": [
                {
                    "src": "src/web/app.py",
                    "use": "@vercel/python"
                }
            ],
            "routes": [
                {
                    "src": "/(.*)",
                    "dest": "src/web/app.py"
                }
            ],
            "env": {
                "RENDER": "true",
                "ENTSOE_API_TOKEN": "fe931761-163e-44ef-b106-854ad60e26ef",
                "PYTHON_VERSION": "3.11.0"
            }
        }
        
        with open("vercel.json", "w") as f:
            json.dump(vercel_config, f, indent=2)
        
        print("✅ Created vercel.json configuration")
        return True
    
    def create_deployment_package(self):
        """Create deployment package"""
        print("📦 Creating deployment package...")
        
        # Create a temporary zip file
        temp_dir = tempfile.mkdtemp()
        zip_path = os.path.join(temp_dir, "deployment.zip")
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Add all necessary files
            files_to_include = [
                "src/",
                "requirements.txt",
                "config.prod.yaml",
                "vercel.json"
            ]
            
            for item in files_to_include:
                if os.path.isfile(item):
                    zipf.write(item)
                elif os.path.isdir(item):
                    for root, dirs, files in os.walk(item):
                        for file in files:
                            file_path = os.path.join(root, file)
                            arcname = os.path.relpath(file_path)
                            zipf.write(file_path, arcname)
        
        print(f"✅ Deployment package created: {zip_path}")
        return zip_path
    
    def deploy_to_vercel(self, zip_path):
        """Deploy to Vercel"""
        print("🚀 Deploying to Vercel...")
        
        try:
            # Read the zip file
            with open(zip_path, 'rb') as f:
                files_data = f.read()
            
            # Create deployment
            deployment_data = {
                "name": "romanian-energy-dashboard",
                "files": [
                    {
                        "file": "deployment.zip",
                        "data": files_data.hex()
                    }
                ],
                "projectSettings": {
                    "framework": "other"
                }
            }
            
            response = requests.post(
                f"{self.api_url}/v13/deployments",
                headers=self.headers,
                json=deployment_data
            )
            
            if response.status_code == 200:
                deployment = response.json()
                deployment_url = f"https://{deployment['url']}"
                print(f"✅ Deployed successfully!")
                print(f"🌐 URL: {deployment_url}")
                return deployment_url
            else:
                print(f"❌ Deployment failed: {response.status_code}")
                print(f"Response: {response.text}")
                return None
                
        except Exception as e:
            print(f"❌ Deployment error: {e}")
            return None
    
    def deploy(self):
        """Main deployment function"""
        print("🚀 Romanian Energy Dashboard - Vercel Deployment")
        print("=" * 60)
        
        # Step 1: Get Vercel token
        if not self.get_vercel_token():
            return False
        
        # Step 2: Test connection
        if not self.test_vercel_connection():
            return False
        
        # Step 3: Create Vercel configuration
        if not self.create_vercel_json():
            return False
        
        # Step 4: Create deployment package
        zip_path = self.create_deployment_package()
        if not zip_path:
            return False
        
        # Step 5: Deploy
        url = self.deploy_to_vercel(zip_path)
        if not url:
            return False
        
        # Step 6: Show results
        print("\n" + "=" * 60)
        print("🎉 DEPLOYMENT COMPLETE!")
        print("=" * 60)
        print(f"🌐 Dashboard URL: {url}")
        print("🔧 Vercel Dashboard: https://vercel.com/dashboard")
        
        print("\n✅ Your Romanian Energy Dashboard is now live!")
        print("📊 Features:")
        print("- Real-time energy data")
        print("- Auto-refresh every 10 seconds")
        print("- Power generation monitoring")
        print("- Imbalance price tracking")
        
        print("\n⚠️ Note: Database features may be limited on Vercel")
        print("For full database support, use Railway or Render deployment")
        
        return True

def main():
    """Main function"""
    deployer = VercelDeployer()
    
    try:
        success = deployer.deploy()
        if success:
            print("\n🎉 Deployment completed successfully!")
            sys.exit(0)
        else:
            print("\n❌ Deployment failed!")
            sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n⚠️ Deployment cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
