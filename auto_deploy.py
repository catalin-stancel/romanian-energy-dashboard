#!/usr/bin/env python3
"""
Fully automated deployment using Railway.app - No manual steps required!
Railway.app allows deployment directly from local files without GitHub.
"""

import os
import sys
import json
import time
import requests
import subprocess
import tempfile
import zipfile
from pathlib import Path

class RailwayDeployer:
    def __init__(self):
        self.base_url = "https://backboard.railway.app/graphql/v2"
        self.headers = {
            "Content-Type": "application/json",
            "User-Agent": "Railway CLI"
        }
        self.project_id = None
        self.service_id = None
        
    def install_railway_cli(self):
        """Install Railway CLI if not present"""
        print("🔧 Checking Railway CLI...")
        
        try:
            result = subprocess.run(["railway", "--version"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Railway CLI is available")
                return True
        except FileNotFoundError:
            pass
        
        print("📦 Installing Railway CLI...")
        try:
            # Install Railway CLI using npm
            result = subprocess.run(["npm", "install", "-g", "@railway/cli"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Railway CLI installed successfully!")
                return True
            else:
                print("⚠️ npm not found, trying alternative installation...")
                return self.install_railway_alternative()
        except FileNotFoundError:
            return self.install_railway_alternative()
    
    def install_railway_alternative(self):
        """Alternative Railway CLI installation"""
        print("📦 Installing Railway CLI (alternative method)...")
        
        try:
            # Try PowerShell installation
            ps_command = 'iwr "https://railway.app/install.ps1" -useb | iex'
            result = subprocess.run(["powershell", "-Command", ps_command], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Railway CLI installed via PowerShell!")
                return True
            else:
                print("❌ Failed to install Railway CLI automatically")
                print("Please install manually: https://docs.railway.app/develop/cli")
                return False
                
        except Exception as e:
            print(f"❌ Installation failed: {e}")
            return False
    
    def login_to_railway(self):
        """Login to Railway"""
        print("🔐 Logging into Railway...")
        
        try:
            # Check if already logged in
            result = subprocess.run(["railway", "whoami"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Already logged into Railway!")
                return True
        except:
            pass
        
        print("🌐 Opening Railway login in browser...")
        try:
            result = subprocess.run(["railway", "login"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Successfully logged into Railway!")
                return True
            else:
                print("❌ Failed to login to Railway")
                return False
        except Exception as e:
            print(f"❌ Login error: {e}")
            return False
    
    def create_project(self):
        """Create Railway project"""
        print("📁 Creating Railway project...")
        
        try:
            result = subprocess.run([
                "railway", "init", 
                "--name", "romanian-energy-dashboard"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Project created successfully!")
                return True
            else:
                print(f"❌ Failed to create project: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Project creation error: {e}")
            return False
    
    def add_database(self):
        """Add PostgreSQL database"""
        print("🗄️ Adding PostgreSQL database...")
        
        try:
            result = subprocess.run([
                "railway", "add", "--database", "postgresql"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ PostgreSQL database added!")
                return True
            else:
                print(f"❌ Failed to add database: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Database creation error: {e}")
            return False
    
    def set_environment_variables(self):
        """Set environment variables"""
        print("⚙️ Setting environment variables...")
        
        env_vars = {
            "RENDER": "true",
            "ENTSOE_API_TOKEN": "fe931761-163e-44ef-b106-854ad60e26ef",
            "PYTHON_VERSION": "3.11.0"
        }
        
        try:
            for key, value in env_vars.items():
                result = subprocess.run([
                    "railway", "variables", "set", f"{key}={value}"
                ], capture_output=True, text=True)
                
                if result.returncode == 0:
                    print(f"✅ Set {key}")
                else:
                    print(f"⚠️ Failed to set {key}")
            
            return True
            
        except Exception as e:
            print(f"❌ Environment variables error: {e}")
            return False
    
    def deploy_application(self):
        """Deploy the application"""
        print("🚀 Deploying application...")
        
        try:
            result = subprocess.run([
                "railway", "up", "--detach"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                print("✅ Application deployed successfully!")
                return True
            else:
                print(f"❌ Deployment failed: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Deployment error: {e}")
            return False
    
    def get_deployment_url(self):
        """Get the deployment URL"""
        print("🌐 Getting deployment URL...")
        
        try:
            result = subprocess.run([
                "railway", "domain"
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                url = result.stdout.strip()
                if url:
                    print(f"✅ Deployment URL: {url}")
                    return url
                else:
                    # Generate domain
                    result = subprocess.run([
                        "railway", "domain", "generate"
                    ], capture_output=True, text=True)
                    
                    if result.returncode == 0:
                        url = result.stdout.strip()
                        print(f"✅ Generated URL: {url}")
                        return url
            
            print("⚠️ Could not get deployment URL")
            return None
            
        except Exception as e:
            print(f"❌ URL retrieval error: {e}")
            return None
    
    def deploy(self):
        """Main deployment function"""
        print("🚀 Romanian Energy Dashboard - Fully Automated Deployment")
        print("Using Railway.app (Free Tier)")
        print("=" * 60)
        
        # Step 1: Install Railway CLI
        if not self.install_railway_cli():
            return False
        
        # Step 2: Login to Railway
        if not self.login_to_railway():
            return False
        
        # Step 3: Create project
        if not self.create_project():
            return False
        
        # Step 4: Add database
        if not self.add_database():
            return False
        
        # Step 5: Set environment variables
        if not self.set_environment_variables():
            return False
        
        # Step 6: Deploy application
        if not self.deploy_application():
            return False
        
        # Step 7: Get deployment URL
        url = self.get_deployment_url()
        
        # Step 8: Show results
        print("\n" + "=" * 60)
        print("🎉 DEPLOYMENT COMPLETE!")
        print("=" * 60)
        
        if url:
            print(f"🌐 Dashboard URL: {url}")
        else:
            print("🌐 Dashboard URL: Check Railway dashboard")
        
        print("🔧 Railway Dashboard: https://railway.app/dashboard")
        print("\n✅ Your Romanian Energy Dashboard is now live!")
        print("📊 Features:")
        print("- Real-time energy data")
        print("- Auto-refresh every 10 seconds")
        print("- Power generation monitoring")
        print("- Imbalance price tracking")
        print("- Background data collection")
        
        print("\n⏱️ Note: First data collection may take 15 minutes")
        
        return True

def main():
    """Main function"""
    deployer = RailwayDeployer()
    
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
