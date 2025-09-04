#!/usr/bin/env python3
"""
Simple automated deployment script for Romanian Energy Balancing Market Dashboard
Uses GitHub + Render.com Blueprint (render.yaml) approach - No API keys required!
"""

import os
import sys
import json
import subprocess
import webbrowser
from pathlib import Path

class SimpleDeployer:
    def __init__(self):
        self.github_repo_url = None
        self.repo_name = "romanian-energy-dashboard"
        
    def check_prerequisites(self):
        """Check if required tools are available"""
        print("🔍 Checking prerequisites...")
        
        # Check Git
        try:
            result = subprocess.run(["git", "--version"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Git is available")
            else:
                print("❌ Git is not available")
                return False
        except FileNotFoundError:
            print("❌ Git is not installed")
            return False
        
        # Check GitHub CLI
        try:
            result = subprocess.run(["gh", "--version"], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ GitHub CLI is available")
                return True
            else:
                print("⚠️ GitHub CLI not found")
                return self.offer_manual_github_setup()
        except FileNotFoundError:
            print("⚠️ GitHub CLI not found")
            return self.offer_manual_github_setup()
    
    def offer_manual_github_setup(self):
        """Offer manual GitHub setup if CLI is not available"""
        print("\n📋 GitHub CLI not found, but we can still deploy!")
        print("You'll need to:")
        print("1. Create a GitHub repository manually")
        print("2. Push the code")
        print("3. Deploy via Render.com web interface")
        print("\nWould you like to continue? (y/n): ", end="")
        
        response = input().strip().lower()
        return response in ['y', 'yes']
    
    def setup_github_with_cli(self):
        """Setup GitHub repository using CLI"""
        print("🔄 Setting up GitHub repository with CLI...")
        
        # Check if user is logged in
        try:
            result = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
            if result.returncode != 0:
                print("🔐 Please login to GitHub CLI:")
                print("Run: gh auth login")
                print("\nPress Enter after logging in...")
                input()
                
                # Check again
                result = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
                if result.returncode != 0:
                    print("❌ Still not logged in. Please run 'gh auth login' first.")
                    return False
        except:
            print("❌ Error checking GitHub CLI authentication")
            return False
        
        # Create repository
        try:
            print(f"📁 Creating repository: {self.repo_name}")
            result = subprocess.run([
                "gh", "repo", "create", self.repo_name,
                "--public",
                "--description", "Romanian Energy Balancing Market Dashboard - Real-time monitoring and analysis",
                "--clone=false"
            ], capture_output=True, text=True)
            
            if result.returncode != 0 and "already exists" not in result.stderr:
                print(f"❌ Failed to create repository: {result.stderr}")
                return False
            
            # Get username and construct URL
            result = subprocess.run(["gh", "api", "user"], capture_output=True, text=True)
            if result.returncode == 0:
                user_data = json.loads(result.stdout)
                username = user_data["login"]
                self.github_repo_url = f"https://github.com/{username}/{self.repo_name}"
                print(f"✅ Repository ready: {self.github_repo_url}")
            else:
                print("❌ Could not determine repository URL")
                return False
            
        except Exception as e:
            print(f"❌ Error creating repository: {e}")
            return False
        
        return self.push_to_github()
    
    def setup_github_manual(self):
        """Setup GitHub repository manually"""
        print("\n📋 Manual GitHub Setup Instructions:")
        print("=" * 50)
        print("1. Go to https://github.com/new")
        print(f"2. Repository name: {self.repo_name}")
        print("3. Make it PUBLIC (required for free Render deployment)")
        print("4. Don't initialize with README (we already have files)")
        print("5. Click 'Create repository'")
        print("\nPress Enter when you've created the repository...")
        input()
        
        # Get repository URL from user
        print("6. Copy your repository URL (e.g., https://github.com/username/repo-name)")
        repo_url = input("Repository URL: ").strip()
        
        if not repo_url or "github.com" not in repo_url:
            print("❌ Invalid repository URL")
            return False
        
        self.github_repo_url = repo_url
        return self.push_to_github()
    
    def push_to_github(self):
        """Push code to GitHub"""
        try:
            print("📤 Pushing code to GitHub...")
            
            # Remove existing remote if any
            subprocess.run(["git", "remote", "remove", "origin"], capture_output=True)
            
            # Add remote
            result = subprocess.run([
                "git", "remote", "add", "origin", f"{self.github_repo_url}.git"
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Failed to add remote: {result.stderr}")
                return False
            
            # Push to GitHub
            result = subprocess.run([
                "git", "push", "-u", "origin", "main"
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Failed to push to GitHub: {result.stderr}")
                print("\n🔧 Troubleshooting:")
                print("- Make sure the repository exists and is public")
                print("- Check your GitHub authentication")
                print("- Try: git push -u origin main --force")
                return False
            
            print("✅ Code pushed to GitHub successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Error pushing to GitHub: {e}")
            return False
    
    def deploy_to_render(self):
        """Deploy to Render.com using Blueprint"""
        print("\n🚀 Deploying to Render.com...")
        print("=" * 50)
        
        print("📋 Render.com Deployment Instructions:")
        print("1. Go to https://render.com (sign up if needed - it's free!)")
        print("2. Click 'New +' button")
        print("3. Select 'Blueprint'")
        print("4. Connect your GitHub account")
        print(f"5. Select your repository: {self.repo_name}")
        print("6. Render will detect the render.yaml file automatically")
        print("7. Click 'Apply' to start deployment")
        print("\n🎯 Render will create:")
        print("   - PostgreSQL database (free)")
        print("   - Web service (dashboard)")
        print("   - Worker service (data collector)")
        
        print(f"\n🌐 Your dashboard will be available at:")
        print(f"   https://romanian-energy-dashboard.onrender.com")
        
        # Open browser automatically
        try:
            print("\n🌍 Opening Render.com in your browser...")
            webbrowser.open("https://render.com/")
            print("✅ Browser opened!")
        except:
            print("⚠️ Could not open browser automatically")
        
        print("\n⏱️ Deployment typically takes 5-10 minutes")
        print("📊 Data collection starts automatically after deployment")
        
        return True
    
    def show_final_instructions(self):
        """Show final instructions and URLs"""
        print("\n" + "=" * 60)
        print("🎉 DEPLOYMENT SETUP COMPLETE!")
        print("=" * 60)
        
        print(f"📁 GitHub Repository: {self.github_repo_url}")
        print("🌐 Expected Dashboard URL: https://romanian-energy-dashboard.onrender.com")
        print("🔧 Render Dashboard: https://dashboard.render.com")
        
        print("\n📋 What happens next:")
        print("1. ⏳ Render builds and deploys your services (5-10 minutes)")
        print("2. 🗄️ PostgreSQL database is created and initialized")
        print("3. 🌐 Web dashboard becomes available")
        print("4. ⚙️ Background worker starts collecting data")
        print("5. 📊 Dashboard shows real-time Romanian energy data")
        
        print("\n🔍 Monitoring deployment:")
        print("- Check build logs in Render dashboard")
        print("- Services may take a few minutes to start")
        print("- First data collection happens within 15 minutes")
        
        print("\n✨ Features of your deployed dashboard:")
        print("- 🔄 Auto-refresh every 10 seconds")
        print("- 📈 Real-time power generation data")
        print("- 💰 Imbalance price monitoring")
        print("- 📊 96 daily intervals (15-minute resolution)")
        print("- 🌍 Accessible from anywhere")
        
        return True
    
    def deploy(self):
        """Main deployment function"""
        print("🇷🇴 Romanian Energy Balancing Market Dashboard")
        print("🚀 Simple Automated Deployment")
        print("=" * 60)
        
        # Step 1: Check prerequisites
        if not self.check_prerequisites():
            return False
        
        # Step 2: Setup GitHub repository
        try:
            # Try CLI first
            result = subprocess.run(["gh", "--version"], capture_output=True, text=True)
            if result.returncode == 0:
                if not self.setup_github_with_cli():
                    print("\n⚠️ CLI setup failed, falling back to manual setup...")
                    if not self.setup_github_manual():
                        return False
            else:
                if not self.setup_github_manual():
                    return False
        except:
            if not self.setup_github_manual():
                return False
        
        # Step 3: Deploy to Render
        if not self.deploy_to_render():
            return False
        
        # Step 4: Show final instructions
        self.show_final_instructions()
        
        return True

def main():
    """Main function"""
    deployer = SimpleDeployer()
    
    try:
        success = deployer.deploy()
        if success:
            print("\n🎉 Setup completed successfully!")
            print("🌐 Your dashboard will be live in 5-10 minutes!")
            sys.exit(0)
        else:
            print("\n❌ Setup failed!")
            sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n⚠️ Setup cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
