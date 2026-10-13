import json
import os
from pathlib import Path

def create_kaggle_json(username: str, api_key: str) -> Path:
    """Creates ~/.kaggle/kaggle.json with valid user permissions."""
    kaggle_dir = Path.home() / ".kaggle"
    kaggle_dir.mkdir(parents=True, exist_ok=True)
    
    kaggle_file = kaggle_dir / "kaggle.json"
    credentials = {"username": username, "key": api_key}
    
    # Write credentials
    kaggle_file.write_text(json.dumps(credentials, indent=2))
    
    # Restrict permissions (required by Kaggle CLI/API on POSIX systems)
    if os.name != "nt":
        kaggle_file.chmod(0o600)
        
    print(f"Successfully configured: {kaggle_file}")
    return kaggle_file

if __name__ == "__main__":
    user = input("Kaggle Username: ").strip()
    key = input("Kaggle API Key: ").strip()
    create_kaggle_json(user, key)