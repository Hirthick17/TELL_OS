import os
import urllib.request
import urllib.error
import json

def get_env_vars(env_file='.env'):
    env_vars = {}
    if not os.path.exists(env_file):
        print(f"Warning: {env_file} not found.")
        return env_vars
    with open(env_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                env_vars[key.strip()] = val.strip()
    return env_vars

def check_gemini(api_key):
    if not api_key: return "Missing"
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                return "Working"
    except urllib.error.HTTPError as e:
        return f"Non-working (Status {e.code})"
    except Exception as e:
        return f"Error: {e}"

def check_meta(access_token):
    if not access_token: return "Missing"
    url = f"https://graph.facebook.com/v17.0/me?access_token={access_token}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                return "Working"
    except urllib.error.HTTPError as e:
        return f"Non-working (Status {e.code})"
    except Exception as e:
        return f"Error: {e}"

def check_mongo_without_pymongo(mongo_url):
    if not mongo_url: return "Missing"
    if mongo_url.startswith("mongodb://") or mongo_url.startswith("mongodb+srv://"):
        return "Format Valid (Install pymongo to test actual connection)"
    return "Invalid Format"

def main():
    env_vars = get_env_vars()
    
    gemini_key = env_vars.get("GEMINI_API_KEY")
    meta_token = env_vars.get("META_ACCESS_TOKEN")
    mongo_url = env_vars.get("MONGO_URL")

    print("\n" + "="*50)
    print("API Key and Service Status Check".center(50))
    print("="*50 + "\n")
    
    print(f"GEMINI_API_KEY     : {check_gemini(gemini_key)}")
    print(f"META_ACCESS_TOKEN  : {check_meta(meta_token)}")
    print(f"MONGO_URL          : {check_mongo_without_pymongo(mongo_url)}")
    
    print("\n" + "="*50 + "\n")

if __name__ == "__main__":
    main()
