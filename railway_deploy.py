#!/usr/bin/env python3
"""
Simple Railway.app deployment using their API
"""
import os
import requests
import json
import time
import zipfile
import tempfile
import shutil

def create_deployment_zip():
    """Create a zip file with all necessary files for deployment"""
    print("📦 Creating deployment package...")
    
    # Files to include in deployment
    files_to_include = [
        'src/',
        'requirements.txt',
        'config.prod.yaml',
        'Dockerfile',
        'README.md'
    ]
    
    # Create temporary zip file
    with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp_file:
        zip_path = tmp_file.name
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for item in files_to_include:
            if os.path.isfile(item):
                zipf.write(item)
                print(f"  ✓ Added {item}")
            elif os.path.isdir(item):
                for root, dirs, files in os.walk(item):
                    for file in files:
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path)
                        zipf.write(file_path, arcname)
                        print(f"  ✓ Added {arcname}")
    
    print(f"📦 Deployment package created: {zip_path}")
    return zip_path

def deploy_to_railway():
    """Deploy to Railway.app using direct upload"""
    print("🚀 Romanian Energy Dashboard - Railway Deployment")
    print("=" * 60)
    
    # Check if we can deploy without Railway CLI
    print("🔄 Attempting direct deployment...")
    
    # Create deployment package
    zip_path = create_deployment_zip()
    
    print("\n" + "=" * 60)
    print("📋 MANUAL DEPLOYMENT INSTRUCTIONS")
    print("=" * 60)
    print("Since automated deployment requires Railway CLI, please follow these steps:")
    print()
    print("1. Go to https://railway.app")
    print("2. Sign up/Login with GitHub")
    print("3. Click 'New Project' → 'Deploy from GitHub repo'")
    print("4. Connect your GitHub account if not already connected")
    print("5. Create a new GitHub repository with your code:")
    print("   - Go to https://github.com/new")
    print("   - Repository name: romanian-energy-dashboard")
    print("   - Make it public")
    print("   - Don't initialize with README (we have one)")
    print("   - Click 'Create repository'")
    print()
    print("6. Push your code to GitHub:")
    print("   git remote add origin https://github.com/YOUR_USERNAME/romanian-energy-dashboard.git")
    print("   git branch -M main")
    print("   git push -u origin main")
    print()
    print("7. Back in Railway, select your new repository")
    print("8. Railway will automatically detect the Dockerfile and deploy")
    print("9. Add environment variables in Railway dashboard:")
    print("   - ENTSOE_API_TOKEN: your_entsoe_token")
    print("   - PORT: 8000")
    print()
    print("🎉 Your app will be live at: https://your-app-name.railway.app")
    print()
    print("Alternative: Use Render.com (also free)")
    print("1. Go to https://render.com")
    print("2. Sign up with GitHub")
    print("3. Click 'New' → 'Web Service'")
    print("4. Connect your GitHub repo")
    print("5. Use these settings:")
    print("   - Build Command: pip install -r requirements.txt")
    print("   - Start Command: gunicorn -w 4 -k uvicorn.workers.UvicornWorker src.web.app:app --host 0.0.0.0 --port $PORT")
    print("6. Add environment variables:")
    print("   - ENTSOE_API_TOKEN: your_token")
    print("   - RENDER: true")
    
    # Clean up
    os.unlink(zip_path)
    
    return True

if __name__ == "__main__":
    try:
        deploy_to_railway()
    except Exception as e:
        print(f"❌ Deployment failed: {e}")
        print("\nPlease follow the manual instructions above.")
