#!/usr/bin/env python3
"""
Automated deployment script for Romanian Energy Balancing Market Dashboard
Deploys to Render.com using their API
"""

import os
import sys
import json
import time
import requests
import subprocess
from pathlib import Path

class RenderDeployer:
    def __init__(self):
        self.base_url = "https://api.render.com/v1"
        self.headers = {
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        self.github_repo_url = None
        self.services = {}
        
    def setup_github_repo(self, repo_name="romanian-energy-dashboard"):
        """Create GitHub repository and push code"""
        print("🔄 Setting up GitHub repository...")
        
        # Check if GitHub CLI is available
        try:
            result = subprocess.run(["gh", "--version"], capture_output=True, text=True)
            if result.returncode != 0:
                print("❌ GitHub CLI not found. Please install it from: https://cli.github.com/")
                return False
        except FileNotFoundError:
            print("❌ GitHub CLI not found. Please install it from: https://cli.github.com/")
            return False
        
        # Check if user is logged in to GitHub CLI
        try:
            result = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
            if result.returncode != 0:
                print("🔐 Please login to GitHub CLI first:")
                print("Run: gh auth login")
                return False
        except:
            print("🔐 Please login to GitHub CLI first:")
            print("Run: gh auth login")
            return False
        
        # Create repository
        try:
            print(f"📁 Creating repository: {repo_name}")
            result = subprocess.run([
                "gh", "repo", "create", repo_name,
                "--public",
                "--description", "Romanian Energy Balancing Market Dashboard - Real-time monitoring and analysis",
                "--clone=false"
            ], capture_output=True, text=True)
            
            if result.returncode != 0 and "already exists" not in result.stderr:
                print(f"❌ Failed to create repository: {result.stderr}")
                return False
            
            # Get the repository URL
            result = subprocess.run(["gh", "repo", "view", "--json", "url"], capture_output=True, text=True)
            if result.returncode == 0:
                repo_data = json.loads(result.stdout)
                self.github_repo_url = repo_data["url"]
                print(f"✅ Repository ready: {self.github_repo_url}")
            else:
                # Fallback to construct URL
                result = subprocess.run(["gh", "api", "user"], capture_output=True, text=True)
                if result.returncode == 0:
                    user_data = json.loads(result.stdout)
                    username = user_data["login"]
                    self.github_repo_url = f"https://github.com/{username}/{repo_name}"
                    print(f"✅ Repository ready: {self.github_repo_url}")
                else:
                    print("❌ Could not determine repository URL")
                    return False
            
        except Exception as e:
            print(f"❌ Error creating repository: {e}")
            return False
        
        # Add remote and push
        try:
            print("📤 Pushing code to GitHub...")
            
            # Add remote
            subprocess.run(["git", "remote", "remove", "origin"], capture_output=True)
            result = subprocess.run([
                "git", "remote", "add", "origin", f"{self.github_repo_url}.git"
            ], capture_output=True, text=True)
            
            # Push to GitHub
            result = subprocess.run([
                "git", "push", "-u", "origin", "main"
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Failed to push to GitHub: {result.stderr}")
                return False
            
            print("✅ Code pushed to GitHub successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Error pushing to GitHub: {e}")
            return False
    
    def get_render_api_key(self):
        """Get Render API key from user"""
        api_key = os.getenv("RENDER_API_KEY")
        if not api_key:
            print("\n🔑 Render API Key Required")
            print("1. Go to https://dashboard.render.com/account/api-keys")
            print("2. Create a new API key")
            print("3. Enter it below:")
            api_key = input("Render API Key: ").strip()
            
            if not api_key:
                print("❌ API key is required")
                return None
        
        self.headers["Authorization"] = f"Bearer {api_key}"
        return api_key
    
    def test_render_connection(self):
        """Test connection to Render API"""
        try:
            response = requests.get(f"{self.base_url}/services", headers=self.headers)
            if response.status_code == 200:
                print("✅ Connected to Render API successfully!")
                return True
            else:
                print(f"❌ Failed to connect to Render API: {response.status_code}")
                print(f"Response: {response.text}")
                return False
        except Exception as e:
            print(f"❌ Error connecting to Render API: {e}")
            return False
    
    def create_database(self):
        """Create PostgreSQL database"""
        print("🗄️ Creating PostgreSQL database...")
        
        database_config = {
            "type": "pserv",
            "name": "romanian-energy-db",
            "plan": "free",
            "databaseName": "romanian_energy_balancing",
            "user": "romanian_energy_user"
        }
        
        try:
            response = requests.post(
                f"{self.base_url}/postgres",
                headers=self.headers,
                json=database_config
            )
            
            if response.status_code == 201:
                db_data = response.json()
                self.services["database"] = db_data
                print(f"✅ Database created: {db_data['name']}")
                return db_data
            else:
                print(f"❌ Failed to create database: {response.status_code}")
                print(f"Response: {response.text}")
                return None
                
        except Exception as e:
            print(f"❌ Error creating database: {e}")
            return None
    
    def create_web_service(self, database_id):
        """Create web service"""
        print("🌐 Creating web service...")
        
        web_config = {
            "type": "web_service",
            "name": "romanian-energy-dashboard",
            "repo": self.github_repo_url,
            "branch": "main",
            "plan": "free",
            "buildCommand": "pip install -r requirements.txt",
            "startCommand": "python -m src.data.models && gunicorn -w 4 -k uvicorn.workers.UvicornWorker src.web.app:app --bind 0.0.0.0:$PORT",
            "healthCheckPath": "/health",
            "envVars": [
                {
                    "key": "RENDER",
                    "value": "true"
                },
                {
                    "key": "ENTSOE_API_TOKEN",
                    "value": "fe931761-163e-44ef-b106-854ad60e26ef"
                },
                {
                    "key": "PYTHON_VERSION",
                    "value": "3.11.0"
                },
                {
                    "key": "DATABASE_URL",
                    "fromDatabase": {
                        "name": "romanian-energy-db",
                        "property": "connectionString"
                    }
                }
            ]
        }
        
        try:
            response = requests.post(
                f"{self.base_url}/services",
                headers=self.headers,
                json=web_config
            )
            
            if response.status_code == 201:
                service_data = response.json()
                self.services["web"] = service_data
                print(f"✅ Web service created: {service_data['name']}")
                return service_data
            else:
                print(f"❌ Failed to create web service: {response.status_code}")
                print(f"Response: {response.text}")
                return None
                
        except Exception as e:
            print(f"❌ Error creating web service: {e}")
            return None
    
    def create_worker_service(self, database_id):
        """Create background worker service"""
        print("⚙️ Creating worker service...")
        
        worker_config = {
            "type": "background_worker",
            "name": "romanian-energy-collector",
            "repo": self.github_repo_url,
            "branch": "main",
            "plan": "free",
            "buildCommand": "pip install -r requirements.txt",
            "startCommand": "python scheduled_collector.py",
            "envVars": [
                {
                    "key": "RENDER",
                    "value": "true"
                },
                {
                    "key": "ENTSOE_API_TOKEN",
                    "value": "fe931761-163e-44ef-b106-854ad60e26ef"
                },
                {
                    "key": "PYTHON_VERSION",
                    "value": "3.11.0"
                },
                {
                    "key": "DATABASE_URL",
                    "fromDatabase": {
                        "name": "romanian-energy-db",
                        "property": "connectionString"
                    }
                }
            ]
        }
        
        try:
            response = requests.post(
                f"{self.base_url}/services",
                headers=self.headers,
                json=worker_config
            )
            
            if response.status_code == 201:
                service_data = response.json()
                self.services["worker"] = service_data
                print(f"✅ Worker service created: {service_data['name']}")
                return service_data
            else:
                print(f"❌ Failed to create worker service: {response.status_code}")
                print(f"Response: {response.text}")
                return None
                
        except Exception as e:
            print(f"❌ Error creating worker service: {e}")
            return None
    
    def wait_for_deployment(self, service_id, service_name):
        """Wait for service deployment to complete"""
        print(f"⏳ Waiting for {service_name} deployment...")
        
        max_attempts = 30  # 15 minutes max
        attempt = 0
        
        while attempt < max_attempts:
            try:
                response = requests.get(
                    f"{self.base_url}/services/{service_id}",
                    headers=self.headers
                )
                
                if response.status_code == 200:
                    service_data = response.json()
                    status = service_data.get("serviceDetails", {}).get("buildStatus", "unknown")
                    
                    if status == "build_successful":
                        print(f"✅ {service_name} deployed successfully!")
                        return True
                    elif status == "build_failed":
                        print(f"❌ {service_name} deployment failed!")
                        return False
                    else:
                        print(f"🔄 {service_name} status: {status}")
                
                time.sleep(30)  # Wait 30 seconds
                attempt += 1
                
            except Exception as e:
                print(f"❌ Error checking deployment status: {e}")
                time.sleep(30)
                attempt += 1
        
        print(f"⏰ Deployment timeout for {service_name}")
        return False
    
    def deploy(self):
        """Main deployment function"""
        print("🚀 Starting automated deployment to Render.com")
        print("=" * 60)
        
        # Step 1: Setup GitHub repository
        if not self.setup_github_repo():
            return False
        
        # Step 2: Get Render API key
        if not self.get_render_api_key():
            return False
        
        # Step 3: Test Render connection
        if not self.test_render_connection():
            return False
        
        # Step 4: Create database
        database = self.create_database()
        if not database:
            return False
        
        # Step 5: Create web service
        web_service = self.create_web_service(database["id"])
        if not web_service:
            return False
        
        # Step 6: Create worker service
        worker_service = self.create_worker_service(database["id"])
        if not worker_service:
            return False
        
        # Step 7: Wait for deployments
        print("\n🔄 Waiting for deployments to complete...")
        
        web_success = self.wait_for_deployment(web_service["id"], "Web Service")
        worker_success = self.wait_for_deployment(worker_service["id"], "Worker Service")
        
        # Step 8: Show results
        print("\n" + "=" * 60)
        print("🎉 DEPLOYMENT COMPLETE!")
        print("=" * 60)
        
        if web_success:
            web_url = f"https://{web_service['name']}.onrender.com"
            print(f"🌐 Dashboard URL: {web_url}")
        
        print(f"📁 GitHub Repository: {self.github_repo_url}")
        print(f"🗄️ Database: {database['name']}")
        
        if web_success and worker_success:
            print("\n✅ All services deployed successfully!")
            print("🔄 Data collection will start automatically")
            print("📊 Dashboard will be available in 2-3 minutes")
        else:
            print("\n⚠️ Some services may have deployment issues")
            print("Check the Render dashboard for details")
        
        return True

def main():
    """Main function"""
    print("Romanian Energy Balancing Market Dashboard")
    print("Automated Deployment to Render.com")
    print("=" * 60)
    
    deployer = RenderDeployer()
    
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
