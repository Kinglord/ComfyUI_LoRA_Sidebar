from server import PromptServer
import os
from aiohttp import web
import aiohttp
import folder_paths
import hashlib
import json
import logging
import io
import mimetypes
import shutil
import asyncio
import time
from collections import Counter
import logging
import glob
import subprocess
import sys
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import random


# Set up logging
DEBUG = False
class ErrorOnlyFilter(logging.Filter):
    def filter(self, record):
        return record.levelno == logging.ERROR

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if DEBUG else logging.ERROR)

handler = logging.StreamHandler()
handler.setLevel(logging.DEBUG if DEBUG else logging.ERROR)

formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)

logger.addHandler(handler)

if not DEBUG:
    error_filter = ErrorOnlyFilter()
    handler.addFilter(error_filter)

# Define the paths
PLUGIN_DIR = os.path.dirname(os.path.realpath(__file__))
LORA_DATA_DIR = os.path.join(PLUGIN_DIR, "loraData")
os.makedirs(LORA_DATA_DIR, exist_ok=True)

# Rate limiting settings
MAX_REQUESTS_PER_MINUTE = 120 # Increase at your own risk, don't get banned!
RATE_LIMITER = None

# Test limit constant
TEST_LIMIT = 0

# Add a global variable to track if processing is in progress
is_processing = False

PROCESSED_LORAS_VERSION = 2  # used to force reprocessing LoRAs when data files change
NEW_ITEM_HOURS = 72
FALLBACK_TIMESTAMP = datetime(2100, 1, 1).timestamp()
LORA_FILE_INFO = {}

# Cache data for faster performance with new sorting
LORA_CACHE = {
    'ordered_loras': None,
    'sent_loras': set()  # Keep track of which LoRAs we've sent to FE
}

# Caching store variables
CACHE_SETTINGS = {
    'sortMethod': 'AlphaAsc',
    'sortModels': 'None',
    'tagSource': 'CivitAI',
    'customTags': [],
    'catNew': True,
    'nsfwFolder': True,
    'nsfwString': '4game'
}

# loading bar stuff
ANSI_COLORS = {
    'GREEN': '\033[92m',
    'BLUE': '\033[94m',
    'CYAN': '\033[96m',
    'YELLOW': '\033[93m',
    'RED': '\033[91m',
    'ENDC': '\033[0m',
    'BOLD': '\033[1m'
}

# Common date formats
DATE_FORMATS = [
    '%Y-%m-%dT%H:%M:%S.%f%z',  # 2024-10-16T01:33:25.4734839+00:00
    '%Y-%m-%dT%H:%M:%S.%f',    # 2024-10-16T01:33:25.473483
    '%Y-%m-%d',                 # 2023-12-25
    '%Y/%m/%d',                 # 2023/12/25
    '%d-%m-%Y',                 # 25-12-2023
    '%d/%m/%Y',                # 25/12/2023
    '%m/%d/%Y',                # 12/25/2023 (US format)
    '%Y-%m-%d %H:%M:%S',       # 2023-12-25 13:45:30
    '%Y-%m-%dT%H:%M:%S',       # 2023-12-25T13:45:30
    '%Y-%m-%dT%H:%M:%SZ',      # 2023-12-25T13:45:30Z
    '%d-%b-%Y',                # 25-Dec-2023
    '%d %b %Y',                # 25 Dec 2023
    '%Y%m%d'                   # 20231225
]

# hack for lora processing
class LoraDataStore:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(LoraDataStore, cls).__new__(cls)
            cls._instance.data = None
        return cls._instance

    @classmethod
    def set_data(cls, data):
        cls._instance = cls()
        cls._instance.data = data
        logger.info(f"Data set in LoraDataStore: {cls._instance.data}")

    @classmethod
    def get_data(cls):
        cls._instance = cls()
        logger.info(f"Data retrieved from LoraDataStore: {cls._instance.data}")
        return cls._instance.data

    @classmethod
    def clear_data(cls):
        cls._instance = cls()
        cls._instance.data = None

class RateLimiter:
    def __init__(self, max_calls, period):
        self.max_calls = max_calls
        self.period = period  # in seconds
        self.calls = []
        self.lock = asyncio.Lock()

    async def acquire(self):
        async with self.lock:
            current = time.time()
            # Remove timestamps older than the period
            while self.calls and self.calls[0] <= current - self.period:
                self.calls.pop(0)
            if len(self.calls) >= self.max_calls:
                wait_time = self.period - (current - self.calls[0])
                logger.debug(f"Rate limit reached. Sleeping for {wait_time:.2f} seconds.")
                await asyncio.sleep(wait_time)
            self.calls.append(time.time())

# Initialize the RateLimiter
RATE_LIMITER = RateLimiter(MAX_REQUESTS_PER_MINUTE, 60)  # 120 calls per 60 seconds

async def get_lora_sort_metadata():
    """
    Gets both dates and names for all LoRA info.json files.
    Returns a dictionary mapping lora_id to {
        'ctime': timestamp, 
        'mtime': timestamp,
        'name': display_name
    }
    """
    sort_metadata = {}
    for folder in os.listdir(LORA_DATA_DIR):
        info_path = os.path.join(LORA_DATA_DIR, folder, "info.json")
        try:
            if os.path.isfile(info_path):
                stats = os.stat(info_path)
                # Get the base info
                sort_metadata[folder] = {
                    'ctime': stats.st_ctime,
                    'mtime': stats.st_mtime,
                    'name': folder  # Default fallback
                }
                
                # Read the name from info.json
                try:
                    with open(info_path, 'r', encoding='utf-8') as f:
                        json_data = json.load(f)
                        sort_metadata[folder]['name'] = json_data.get('name', folder)
                except json.JSONDecodeError:
                    logger.error(f"Error reading info.json for {folder}")
                    
        except (OSError, IOError) as e:
            logger.error(f"Error getting info for {folder}: {str(e)}")
            continue
    return sort_metadata

async def hash_file(filepath):
    # Check for local saved hash
    stripped_file_path = os.path.splitext(filepath)[0]
    hash_path = stripped_file_path + ".sha256"
    
    # If local hash file exists, read it
    if os.path.isfile(hash_path):
        try:
            with open(hash_path, "rt") as f:
                return f.read().strip()
        except Exception as e:
            logger.warning(f"Error reading hash file {hash_path}: {str(e)}")

    # Nothing local, so let's hash it ourselves
    sha256_hash = hashlib.sha256()
    with open(filepath, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

async def check_local_info(file_path):
    # Try CivitAI first
    civitai_info_path = f"{os.path.splitext(file_path)[0]}.civitai.info"
    logger.info(f"Checking for CivitAI metadata at: {civitai_info_path}")
   
    if os.path.exists(civitai_info_path):
        try:
            logger.info(f"Found CivitAI metadata file, attempting to read: {civitai_info_path}")
            with open(civitai_info_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
               
            return {
                "modelId": metadata.get("modelId"),
                "id": metadata.get("id"),  # Version ID from the info
                "name": metadata.get("name"), # Version name
                "model": {
                    "name": metadata.get("model", {}).get("name"),
                    "nsfw": metadata.get("model", {}).get("nsfw", False),
                    "tags": metadata.get("model", {}).get("tags", []),
                    "description": metadata.get("model", {}).get("description"),  # Model description
                    "type": metadata.get("model", {}).get("type")
                },
                "trainedWords": metadata.get("trainedWords", []),
                "baseModel": metadata.get("baseModel"),
                "description": metadata.get("description"),  # Version description
                "images": metadata.get("images", []),
                "createdAt": metadata.get("createdAt"),  # Match API format
                "updatedAt": metadata.get("updatedAt"),  # Match API format
                "local_metadata": True,  # Add flag
                "has_local_images": True
            }
        except Exception as e:
            logger.error(f"Error reading civitai.info for {file_path}: {str(e)}")
    
    # Try SMatrix second
    matrix_info_path = f"{os.path.splitext(file_path)[0]}.cm-info.json"
    logger.info(f"Checking for SMatrix metadata at: {matrix_info_path}")
    
    if os.path.exists(matrix_info_path):
        try:
            logger.info(f"Found SMatrix metadata file, attempting to read: {matrix_info_path}")
            with open(matrix_info_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
                
            return {
                "modelId": metadata.get("ModelId"),
                "id": metadata.get("VersionId"),  # Version ID
                "name": metadata.get("VersionName"),
                "model": {
                    "name": metadata.get("ModelName"),
                    "nsfw": metadata.get("Nsfw", False),
                    "tags": metadata.get("Tags", []),
                    "description": metadata.get("ModelDescription"),
                    "type": metadata.get("ModelType")
                },
                "trainedWords": metadata.get("TrainedWords", []),
                "baseModel": metadata.get("BaseModel"),
                "description": metadata.get("VersionDescription"),
                "images": [],
                "createdAt": metadata.get("ImportedAt"), #all we have is imported date here so using it for both
                "updatedAt": metadata.get("ImportedAt"),
                "local_metadata": True,
                "has_local_images": True
            }
        except Exception as e:
            logger.error(f"Error reading cm-info.json for {file_path}: {str(e)}")
    
    # Try rg3  third...get it?
    rg3_info_path = f"{os.path.splitext(file_path)[0]}.safetensors.rgthree-info.json"
    logger.info(f"Checking for RG3 metadata at: {rg3_info_path}")

    if os.path.exists(rg3_info_path):
        try:
            logger.info(f"Found RG3 metadata file, attempting to read: {rg3_info_path}")
            with open(rg3_info_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
                
            civitai = metadata.get('raw', {}).get('civitai', {})
                
            return_data = {
                "modelId": civitai.get("modelId"),
                "id": civitai.get("id"),
                "name": civitai.get("name"),  # version name
                "model": {
                    "name": civitai.get("model", {}).get("name"),
                    "nsfw": civitai.get("model", {}).get("nsfw", False),
                    "description": None,
                    "type": civitai.get("model", {}).get("type"),
                },
                "trainedWords": civitai.get("trainedWords", []),
                "baseModel": civitai.get("baseModel"),
                "description": civitai.get("description"),  # version desc
                "images": [
                    {
                        "url": img.get("url"),
                        "type": img.get("type", "image"),
                        "hasMeta": img.get("hasMeta", False),
                        "nsfwLevel": img.get("nsfwLevel", 0)
                    }
                    for img in civitai.get("images", [])
                ],
                "createdAt": civitai.get("createdAt"),
                "updatedAt": civitai.get("updatedAt"),
                "local_metadata": True,
                "has_local_images": False
            }
            
            logger.info(f"Successfully parsed RG3 metadata for {file_path}")
            logger.info(f"RG3 metadata {return_data}")
            return return_data
        
        except Exception as e:
            logger.error(f"Error reading safetensors.rgthree-info.json for {file_path}: {str(e)}")
    
    # No valid metadata found in any format
    logger.info(f"No valid metadata found for: {file_path}")
    return False

async def fetch_model_info(session, model_id, skip_rate_limit=False):
    url = f"https://civitai.com/api/v1/models/{model_id}"
    if not skip_rate_limit:
        await RATE_LIMITER.acquire()
    async with session.get(url) as response:
        if response.status == 200:
            return await response.json()
    return None

async def fetch_version_info(session, file_hash):
    url = f"https://civitai.com/api/v1/model-versions/by-hash/{file_hash}"
    await RATE_LIMITER.acquire()  # Enforce rate limit
    
    try:
        async with session.get(url) as response:
            if response.status == 200:
                return await response.json()
            elif response.status == 404:
                # Expected response for custom LoRAs and removed content
                logger.info(f"Hash lookup failed for {file_hash}, likely a custom LoRA or removed content. Falling back to local data.")
            else:
                # Unexpected API response
                logger.warning(f"Unexpected response from CivitAI API: {response.status}")
    except Exception as e:
        logger.warning(f"Error during hash lookup: {str(e)}")
    
    return None

async def fetch_version_info_by_id(session, version_id, skip_rate_limit=False):
    url = f"https://civitai.com/api/v1/model-versions/{version_id}"
    if not skip_rate_limit:
        await RATE_LIMITER.acquire()
    async with session.get(url) as response:
        if response.status == 200:
            return await response.json()
    return None

async def download_image(session, image_url, save_path):
    # await RATE_LIMITER.acquire()  # here in case but would rather not rate limit this
    async with session.get(image_url) as response:
        if response.status == 200:
            content_type = response.headers.get('Content-Type', '')
            ext = mimetypes.guess_extension(content_type) or '.jpg'
            final_save_path = f"{os.path.splitext(save_path)[0]}{ext}"
            with open(final_save_path, 'wb') as f:
                f.write(await response.read())
            return os.path.basename(final_save_path)
    return None

def get_tag_categories(settings):
    """Get appropriate tag categories based on settings."""
    PREDEFINED_TAGS = [
        "character", "style", "celebrity", "concept", "clothing", "poses", 
        "background", "tool", "buildings", "vehicle", "objects", "animal", "assets", "action"
    ]
    
    if settings['tagSource'] == 'CivitAI':
        return PREDEFINED_TAGS
    return [tag.strip().lower() for tag in settings.get('customTags', [])]

def format_date(date_input):
    """
    Convert any reasonable date format to YYYY-MM-DD.
    Returns 'unknown' for invalid/missing dates.
    
    Handles:
    - ISO 8601 timestamps (2024-10-24T12:14:32.925Z)
    - Simple dates (2024-10-24)
    - Unix timestamps
    """
    if not date_input:
        return "unknown"
        
    try:
        # If it's already a datetime object
        if isinstance(date_input, datetime):
            dt = date_input
        # If it's a string, try parsing it
        elif isinstance(date_input, str):
            # Try ISO format first (handles both full timestamps and simple dates)
            try:
                dt = datetime.fromisoformat(date_input.replace('Z', '+00:00'))
            except ValueError:
                # If that fails, try basic date format
                dt = datetime.strptime(date_input, '%Y-%m-%d')
        # If it's a number (timestamp)
        elif isinstance(date_input, (int, float)):
            dt = datetime.fromtimestamp(date_input)
        else:
            return "unknown"
            
        return dt.strftime('%Y-%m-%d')
        
    except Exception as e:
        logger.error(f"Error formatting date {date_input}: {str(e)}")
        return "unknown"

async def copy_placeholder_as_preview(lora_id):
    placeholder_path = os.path.join(LORA_DATA_DIR, "placeholder.jpeg")
    lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
    preview_path = os.path.join(lora_folder, "preview.jpeg")
    
    # Ensure the LoRA folder exists
    os.makedirs(lora_folder, exist_ok=True)
    
    if os.path.exists(placeholder_path) and not os.path.exists(preview_path):
        shutil.copy(placeholder_path, preview_path)
        logger.info(f"Placeholder image copied as preview for LoRA {lora_id}")
    else:
        if not os.path.exists(placeholder_path):
            logger.warning(f"Placeholder image not found: {placeholder_path}")
        if os.path.exists(preview_path):
            logger.info(f"Preview already exists for LoRA {lora_id}: {preview_path}")

def get_subdir(file_path):
    """Get the subdirectory relative to the lora base path."""
    try:
        # Get all possible lora directories from folder_paths
        lora_dirs = folder_paths.get_folder_paths("loras")
        logger.debug(f"Input file_path: {file_path}")
        logger.debug(f"Lora dirs from folder_paths: {lora_dirs}")

        # Filter out output directories
        lora_dirs = [d for d in lora_dirs if 'output' not in d.lower().split(os.sep)]
        
        logger.debug(f"Lora dirs from folder_paths (excluding output dirs): {lora_dirs}")
        
        if not lora_dirs:
            return ""
            
        # Normalize the input path
        norm_path = os.path.normpath(file_path)
        logger.debug(f"Normalized input path: {norm_path}")
        
        # Handle cross-drive path comparison by normalizing drive letters
        file_drive, file_path_tail = os.path.splitdrive(norm_path)
        
        # Find the matching base directory
        matching_base = None
        matching_link = None
        
        for base_dir in lora_dirs:
            base_dir = os.path.normpath(base_dir)
            logger.debug(f"\nChecking base dir: {base_dir}")
            
            # Check for symlinks in this lora directory
            try:
                for item in os.listdir(base_dir):
                    link_path = os.path.join(base_dir, item)
                    if os.path.islink(link_path):
                        real_link = os.path.realpath(link_path)
                        logger.debug(f"Found symlink: {item} -> {real_link}")
                        
                        # Apply drive neutralization to symlink target
                        link_drive, link_tail = os.path.splitdrive(real_link)
                        neutral_link = os.path.join("C:", link_tail)
                        neutral_file = os.path.join("C:", file_path_tail)
                        
                        if neutral_file.startswith(neutral_link):
                            matching_base = real_link
                            matching_link = item
                            logger.debug(f"Found matching symlink: {item}")
                            break
            except Exception as e:
                logger.debug(f"Error checking symlinks in {base_dir}: {str(e)}")
                continue
            
            # Regular path matching as before
            base_drive, base_path_tail = os.path.splitdrive(base_dir)
            
            # Create drive-letter-neutral paths for comparison
            neutral_file_path = os.path.join("C:", file_path_tail)
            neutral_base_path = os.path.join("C:", base_path_tail)
            
            logger.debug(f"Neutral paths for comparison:")
            logger.debug(f"  neutral_file_path: {neutral_file_path}")
            logger.debug(f"  neutral_base_path: {neutral_base_path}")
            
            # Check if this base matches
            if neutral_file_path.startswith(neutral_base_path):
                logger.debug(f"Found matching base! Length: {len(base_dir)}")
                if matching_base is None or len(base_dir) > len(matching_base):
                    matching_base = base_dir
                    logger.debug(f"Updated matching_base to: {matching_base}")
        
        if not matching_base:
            logger.debug("No matching base directory found")
            return ""
            
        logger.debug(f"Final matching base: {matching_base}")
        
        # If we matched via symlink, construct the path accordingly
        if matching_link:
            # Get the part of the path after the symlink target
            _, match_tail = os.path.splitdrive(matching_base)
            neutral_match = os.path.join("C:", match_tail)
            neutral_file = os.path.join("C:", file_path_tail)
            
            after_base = neutral_file[len(neutral_match):].lstrip('\\/')
            rel_path = os.path.join(matching_link, os.path.dirname(after_base))
            logger.debug(f"Constructed symlink path: {rel_path}")
            return rel_path
        
        # Regular path handling as before
        _, match_path_tail = os.path.splitdrive(matching_base)
        neutral_match_path = os.path.join("C:", match_path_tail)
        
        logger.debug(f"Neutral match path for relpath calc: {neutral_match_path}")
        
        # Calculate relative path
        try:
            rel_path = os.path.relpath(os.path.dirname(neutral_file_path), neutral_match_path)
            logger.debug(f"Calculated relpath: {rel_path}")
        except Exception as e:
            logger.error(f"Error calculating relpath: {str(e)}")
            return ""
        
        # Return empty string for root directory
        if rel_path == ".":
            logger.debug("Relpath is root directory")
            return ""
            
        logger.debug(f"Final relative path: {rel_path}")
        return rel_path
            
    except Exception as e:
        logger.error(f"Error in get_subdir: {str(e)}")
        logger.error(f"File path: {file_path}")
        return ""
    
def find_custom_images(base_path, base_filename):
    """Find custom images for a LoRA in both internal and external locations"""
    custom_images = []
    
    # Get the directory containing the base file
    base_dir = os.path.dirname(base_path)
    
    # Get base name without extension for matching
    name_without_ext = os.path.splitext(base_filename)[0]
    
    # Common image extensions to look for
    image_extensions = ('.jpg', '.jpeg', '.png', '.webp')
    
    logger.info(f"Searching for custom images in {base_dir} for {base_filename}")
    
    # For internal loras, look in the lora data directory
    lora_data_path = os.path.join(LORA_DATA_DIR, name_without_ext)
    if os.path.exists(lora_data_path):
        for file in os.listdir(lora_data_path):
            if file.lower().endswith(image_extensions) and not file.startswith('preview'):
                logger.info(f"Found internal custom image: {file}")
                custom_images.append({
                    "url": f"/lora_sidebar/custom_image/{name_without_ext}/{file}",
                    "type": "image",
                    "nsfwLevel": 0,
                    "hasMeta": True,
                    "custom": True,
                    "name": file
                })
    
    # Look for images in the LoRA's directory
    if os.path.exists(base_dir):
        for file in os.listdir(base_dir):
            if (file.lower().startswith(name_without_ext.lower()) and 
                file.lower().endswith(image_extensions) and
                not file.lower().endswith('.preview' + os.path.splitext(file)[1])):
                logger.info(f"Found external custom image: {file}")
                custom_images.append({
                    "url": f"/lora_sidebar/custom_image/{name_without_ext}/{file}",
                    "type": "image",
                    "nsfwLevel": 0,
                    "hasMeta": True,
                    "custom": True,
                    "name": file
                })
    
    logger.info(f"Found total of {len(custom_images)} custom images")
    return custom_images

def manage_category_counts(action="calculate", **kwargs):
    """
    Unified category count management.
    
    Args:
        action: Type of operation ("calculate" or "update")
        kwargs: Arguments based on action type:
            For "calculate":
                loras: Full list of loras
                paginated_loras: Current page of loras (optional)
                settings: User settings
            For "update":
                old_category: Previous category
                new_category: New category
                current_counts: Existing counts dict (optional)
    """
    if not LORA_CACHE.get('ordered_loras'):
        return None

    if action == "calculate":
        loras = kwargs.get('loras', [])
        paginated_loras = kwargs.get('paginated_loras', [])
        settings = kwargs.get('settings', {})
        
        category_counts = {}
        
        # Count real categories
        for lora in loras:
            if not lora['favorite'] and not lora['is_new']: # don't count favs or new items
                category = lora['category']
                if category not in category_counts:
                    category_counts[category] = {'total': 0, 'loaded': 0}
                category_counts[category]['total'] += 1

        # Add status counts
        status_counts = {
            'Favorites': {'total': len([l for l in loras if l['favorite']])},
            'New': {'total': len([l for l in loras if l['is_new'] and not l['favorite']])}
        }
        category_counts.update(status_counts)

        # Count loaded if provided
        if paginated_loras:
            for lora in paginated_loras:
                if lora['favorite']:
                    category_counts['Favorites']['loaded'] = category_counts['Favorites'].get('loaded', 0) + 1
                elif lora['is_new'] and settings.get('catNew'):
                    category_counts['New']['loaded'] = category_counts['New'].get('loaded', 0) + 1
                else:
                    category = lora['category']
                    category_counts[category]['loaded'] = category_counts[category].get('loaded', 0) + 1

    elif action == "update":
        old_category = kwargs.get('old_category')
        new_category = kwargs.get('new_category')
        category_counts = dict(kwargs.get('current_counts', LORA_CACHE.get('category_info', {})))

        # Ensure categories exist
        for cat in [old_category, new_category]:
            if cat and cat not in category_counts:
                category_counts[cat] = {'total': 0, 'loaded': 0}
            
        # Update counts
        if old_category:
            category_counts[old_category]['total'] -= 1
            if 'loaded' in category_counts[old_category]:
                category_counts[old_category]['loaded'] -= 1
            
        if new_category:
            category_counts[new_category]['total'] += 1
            if 'loaded' in category_counts[new_category]:
                category_counts[new_category]['loaded'] += 1

    # Update cache and return
    LORA_CACHE['category_info'] = category_counts
    logger.debug(f"cat counts from category counter: {category_counts}")
    return category_counts

def validate_processed_loras(processed_loras):
    """Validate and clean processed_loras data, keeping newest paths"""
    # Ensure we have required structure
    if not isinstance(processed_loras, dict):
        return {
            "version": PROCESSED_LORAS_VERSION,
            "loras": [],
            "favorites": []
        }
    
    # Ensure required keys exist
    processed_loras.setdefault("version", PROCESSED_LORAS_VERSION)
    processed_loras.setdefault("loras", [])
    processed_loras.setdefault("favorites", [])
    
    # Check for duplicates - keep entry with newest path
    entries_by_filename = {}
    for lora in processed_loras["loras"]:
        filename = lora.get("filename")
        if filename:
            # If we've seen this filename before, keep the newer path
            if filename in entries_by_filename:
                # Check if this path is different from what we have
                if lora.get("path") != entries_by_filename[filename].get("path"):
                    # Update to the new path
                    entries_by_filename[filename]["path"] = lora.get("path")
                    logger.info(f"Updated path for {filename} to: {lora.get('path')}")
            else:
                entries_by_filename[filename] = lora
    
    # Convert back to list, now with unique entries and newest paths
    processed_loras["loras"] = list(entries_by_filename.values())
    return processed_loras

def get_completion_message(lora_count):
    # after all this i need to have some fun
    messages = {
        0: [
            "No LoRAs found - your collection awaits! 🟢",
            "Empty canvas - ready for your first LoRA! 🎨",
            "Time to start your LoRA adventure! 🚀"
        ],
        1: [
            "A humble beginning - keep going! 🔰",
            "🥠 There are more LoRAs in your future.",
            "IT HAS BEGUN! *DUN-DUN-DUN-DUN-DA-DA-DUN-DUN-DUN-DUN*",
            "I appreciate it, but honestly - why did you even download this thing? 😂"
        ],
        50: [
            "Nice collection! You're well on your way to LoRA mastery. 🎓",
            "Your LoRA library is growing! 👍",
            "A curator of fine LoRAs, I see! 🛒",
        ],
        500: [
            "Impressive arsenal of LoRAs! You're a serious collector. 🥃",
            "Your LoRA collection is becoming a force to be reckoned with! 💪",
            "Triple digits! Now that's dedication...or something else... 💦",
            "Are ya winning, son? 🤠"
        ],
        2000: [
            "This collection is getting scary! 😱",
            "Your LoRA collection is award winng, just don't ask which one! 🥇",
            "You know I can see these LoRAs...right? 👀",
            "I know, you can stop anytime you want. 🚬"
        ],
        9000: [
            "WHAT?! IT'S OVER 9000!!! 🤯",
            "They said they had a lot of LoRAs. You said, Hold my beer. 🍺",
            "Behold, a true LoRA connoisseur walks among us! ಠ_ರೃ",
            "You don't remember downloading half of these, do you? 🤔"
        ],
        15000: [
            "Are you from Sparta? Because this IS MADNESS! ⚔️",
            "Impressive. Most Impressive. 🌑",
            "⊙▂⊙"
        ],
        float('inf'): [
            "🏆 HOW DID THIS EVEN LOAD?!? 🏆",
            "🏆 GOD TIER 🏆",
            "🏆 CIVITAI WISHES IT WAS THIS COOL 🏆"
        ]
    }
    
    # Find the appropriate threshold
    threshold = max((t for t in messages.keys() if lora_count >= t), key=lambda x: x if x != float('inf') else float('-inf'))
    
    # Return a random message from that threshold's list
    return random.choice(messages[threshold])

@PromptServer.instance.routes.get("/lora_sidebar/loras/list")
async def list_loras(request):
    global LORA_FILE_INFO
    logger.info(f"Pulling LoRA list from route: {request.path}")
    logger.info("Pulling LoRA list")
    lora_dirs = folder_paths.get_folder_paths("loras")
    lora_files = []
   
    for lora_dir in lora_dirs:
        # Resolve symlinks to ensure proper path handling
        resolved_lora_dir = os.path.realpath(lora_dir)
        
        if os.path.exists(resolved_lora_dir):
            # Use os.walk to recursively walk through subfolders and resolve symlinks
            for root, dirs, files in os.walk(resolved_lora_dir, followlinks=True):
                for filename in files:
                    # Skip hidden files and system files starting with "._"
                    if filename.startswith('.') or filename.startswith('._'):
                        continue

                    file_path = os.path.join(root, filename)
                    
                    # Resolve any symlinks to their actual path and check if it's a file
                    resolved_file_path = os.path.realpath(file_path)
                    if os.path.isfile(resolved_file_path) and filename.lower().endswith(('.safetensors', '.ckpt', '.pt')):
                        lora_files.append({"filename": filename, "path": resolved_file_path})
                        
                        # Store in LORA_FILE_INFO
                        LORA_FILE_INFO[os.path.splitext(filename)[0].strip()] = {"filename": filename, "path": resolved_file_path}
                        
                        if TEST_LIMIT > 0 and len(lora_files) >= TEST_LIMIT:
                            break
                if TEST_LIMIT > 0 and len(lora_files) >= TEST_LIMIT:
                    break
    
    return lora_files

@PromptServer.instance.routes.get("/lora_sidebar/file_details/{lora_id}")
async def get_file_details(request):
    lora_id = request.match_info['lora_id']
    lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
    
    try:
        return web.json_response({
            "managed_dir": lora_folder,
            "exists": os.path.exists(lora_folder)
        })
    except Exception as e:
        logger.error(f"Error getting file details: {str(e)}")
        return web.json_response({
            "error": "Failed to get file details"
        }, status=500)

@PromptServer.instance.routes.get("/lora_sidebar/preview/{lora_name}")
async def get_lora_preview(request):
    # Load preview media with proper MIME type handling.
    lora_name = request.match_info['lora_name']
    
    def get_content_type(filepath):
        ext = os.path.splitext(filepath)[1].lower()
        content_types = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm'
        }
        return content_types.get(ext, 'application/octet-stream')
    
    # Look in managed folder
    lora_folder = os.path.join(LORA_DATA_DIR, lora_name)
    for ext in ['.jpg', '.png', '.jpeg', '.mp4', '.webm']:
        preview_path = os.path.join(lora_folder, f"preview{ext}")
        if os.path.exists(preview_path):
            return web.FileResponse(
                preview_path,
                headers={"Content-Type": get_content_type(preview_path)}
            )
    
    # Check if this LoRA uses local image data
    info_path = os.path.join(LORA_DATA_DIR, lora_name, "info.json")
    if os.path.exists(info_path):
        with open(info_path, "r", encoding="utf-8") as f:
            info = json.load(f)
            logger.info(f"Loading info for {lora_name}: local_metadata={info.get('local_metadata')}, path={info.get('path')}")
            if info.get("local_metadata") and info.get("path"):
                base_path = os.path.splitext(info["path"])[0]
                for ext in ['.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.mp4', '.preview.webm']:
                    preview_path = f"{base_path}{ext}"
                    if os.path.exists(preview_path):
                        return web.FileResponse(
                            preview_path,
                            headers={"Content-Type": get_content_type(preview_path)}
                        )
        
    # Fallback to placeholder
    placeholder_path = os.path.join(LORA_DATA_DIR, "placeholder.jpeg")
    if os.path.exists(placeholder_path):
        return web.FileResponse(
            placeholder_path,
            headers={"Content-Type": "image/jpeg"}
        )
    
    return web.Response(status=404)

@PromptServer.instance.routes.get("/lora_sidebar/info/{lora_name}")
async def get_lora_info(request):
    try:
        lora_name = request.match_info['lora_name']
        info_path = os.path.join(LORA_DATA_DIR, lora_name, "info.json")
        
        if not os.path.exists(info_path):
            return web.json_response({
                "status": "error",
                "message": "LoRA info file not found"
            }, status=404)
        
        with open(info_path, "r", encoding="utf-8") as f:
            info_data = json.load(f)
            
        return web.json_response({
            "status": "success",
            "info": info_data
        })
            
    except Exception as e:
        logger.error(f"Error getting LoRA info: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

@PromptServer.instance.routes.get("/lora_sidebar/custom_image/{lora_name}/{image_name}")
async def get_lora_custom_image(request):
    # Load custom images for a LoRA
    lora_name = request.match_info['lora_name']
    image_name = request.match_info['image_name']
    
    def get_content_type(filepath):
        ext = os.path.splitext(filepath)[1].lower()
        content_types = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp'
        }
        return content_types.get(ext, 'application/octet-stream')
    
    logger.info(f"Looking for custom image {image_name} for LoRA {lora_name}")
    
    # Check internal lora data directory first (existing behavior)
    custom_path = os.path.join(LORA_DATA_DIR, lora_name, image_name)
    if os.path.exists(custom_path) and os.path.isfile(custom_path):
        logger.info(f"Found image in internal directory: {custom_path}")
        return web.FileResponse(
            custom_path,
            headers={"Content-Type": get_content_type(custom_path)}
        )
    
    # Then check actual LoRA location if we have the info
    if lora_name in LORA_FILE_INFO:
        file_info = LORA_FILE_INFO[lora_name]
        base_dir = os.path.dirname(file_info['path'])
        
        # Try exact match first
        external_path = os.path.join(base_dir, image_name)
        if os.path.exists(external_path) and os.path.isfile(external_path):
            logger.info(f"Found exact match image in LoRA directory: {external_path}")
            return web.FileResponse(
                external_path,
                headers={"Content-Type": get_content_type(external_path)}
            )
            
        # If no exact match, try looking for images with LoRA name prefix
        lora_filename = os.path.splitext(file_info['filename'])[0]
        for file in os.listdir(base_dir):
            if (file.lower().startswith(lora_filename.lower()) and 
                file.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and
                not file.lower().endswith('.preview.png')):
                external_path = os.path.join(base_dir, file)
                logger.info(f"Found matching prefixed image: {external_path}")
                return web.FileResponse(
                    external_path,
                    headers={"Content-Type": get_content_type(external_path)}
                )
    
    logger.info(f"No matching image found for {lora_name}/{image_name}")
    return web.Response(status=404)

@PromptServer.instance.routes.get("/lora_sidebar/placeholder")
async def get_placeholder(request):
    placeholder_path = os.path.join(LORA_DATA_DIR, "placeholder.jpeg")
    if os.path.exists(placeholder_path):
        return web.FileResponse(placeholder_path)
    return web.Response(status=404)

@PromptServer.instance.routes.get("/lora_sidebar/unprocessed_count")
async def get_unprocessed_count(request):
    logger.info("Starting fresh: Scanning for unprocessed LoRAs")

    processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
    # Initialize processed_loras with default structure
    processed_loras = {
        "version": PROCESSED_LORAS_VERSION,
        "loras": [],
        "favorites": []
    }
    
    # Get the current LoRA files first
    lora_files = await list_loras(request)
    current_lora_names = [os.path.splitext(lf['filename'])[0].strip() for lf in lora_files]

    # Check version and handle existing data
    if os.path.exists(processed_loras_file):
        with io.open(processed_loras_file, "r", encoding="utf-8") as f:
            try:
                loaded_data = json.load(f)
                if not isinstance(loaded_data, dict) or not loaded_data.get('version') or loaded_data.get('version') < PROCESSED_LORAS_VERSION:
                    logger.info(f"Outdated or missing version, marking all LoRAs for reprocessing (current version: {PROCESSED_LORAS_VERSION})")
                    # Preserve favorites but clear loras list
                    favorites = loaded_data.get('favorites', []) if isinstance(loaded_data, dict) else []
                    processed_loras = {
                        "version": PROCESSED_LORAS_VERSION,
                        "loras": [],
                        "favorites": favorites
                    }
                    # Save the updated structure
                    with io.open(processed_loras_file, "w", encoding="utf-8") as f:
                        json.dump(processed_loras, f, indent=4, ensure_ascii=False)
                        
                    # All current loras need processing
                    response_data = {
                        "unprocessed_count": len(current_lora_names),
                        "new_loras": current_lora_names,
                        "moved_loras": [],
                        "duplicate_loras": [],
                        "missing_loras": [],
                        "local_metadata": 0,
                        "remote_metadata": 0
                    }
                    
                    LoraDataStore.set_data(response_data)
                    return web.json_response(response_data)
                else:
                    processed_loras = loaded_data
            except json.JSONDecodeError:
                logger.error("Error reading processed_loras.json")

    unprocessed_count = 0
    new_loras = []
    moved_loras = []
    duplicate_loras = []
    local_metadata_count = 0
    remote_metadata_needed = 0

    # Create a dictionary of processed LoRAs (keyed by filename)
    processed_loras_dict = {lora['filename']: lora['path'] for lora in processed_loras['loras']}

    # Create a dictionary of current LoRAs (keyed by filename) and count occurrences
    current_loras = {os.path.splitext(lf['filename'])[0].strip(): lf['path'] for lf in lora_files}
    filename_count = Counter(current_loras.keys())
    potential_duplicates = [filename for filename, count in filename_count.items() if count > 1]

    # Check each lora
    for base_filename, file_path in current_loras.items():
        needs_processing = False
        
        if base_filename in potential_duplicates:
            if base_filename not in processed_loras_dict:
                new_loras.append(base_filename)
                needs_processing = True
            elif processed_loras_dict[base_filename] != file_path:
                moved_loras.append(base_filename)
                needs_processing = True
            duplicate_loras.append(base_filename)
        else:
            if base_filename not in processed_loras_dict:
                new_loras.append(base_filename)
                needs_processing = True
            elif processed_loras_dict[base_filename] != file_path:
                moved_loras.append(base_filename)
                needs_processing = True

        # If this LoRA needs processing, check for local metadata
        if needs_processing:
            if await check_local_info(file_path):
                local_metadata_count += 1
            else:
                remote_metadata_needed += 1

    # Check for missing LoRAs
    missing_loras = [lora for lora in processed_loras_dict.keys() 
                    if lora.strip() not in current_loras]

    total_unprocessed = len(new_loras) + len(moved_loras) + len(missing_loras)
    
    logger.info(f"Total LoRAs: {len(lora_files)}, Unprocessed: {total_unprocessed}")
    logger.info(f"New: {len(new_loras)}, Moved: {len(moved_loras)}, Missing: {len(missing_loras)}")
    logger.info(f"Local Metadata: {local_metadata_count}, Needs Remote: {remote_metadata_needed}")

    response_data = {
        "unprocessed_count": total_unprocessed,
        "new_loras": new_loras,
        "moved_loras": moved_loras,
        "duplicate_loras": duplicate_loras,
        "missing_loras": missing_loras,
        "local_metadata": local_metadata_count,
        "remote_metadata": remote_metadata_needed
    }

    LoraDataStore.set_data(response_data)
    return web.json_response(response_data)


@PromptServer.instance.routes.get("/lora_sidebar/estimate")
async def estimate_processing_time(request):
    # Extract 'count' from query parameters
    params = request.rel_url.query
    count_new_str = params.get('new', '0')
    count_moved_str = params.get('moved', '0')
    count_missing_str = params.get('missing', '0')
    count_local_str = params.get('local', '0')
    count_remote_str = params.get('remote', '0')
    
    try:
        num_unprocessed = int(count_new_str) + int(count_moved_str) + int(count_missing_str)
        num_new = int(count_new_str)
        num_moved = int(count_moved_str)
        num_missing = int(count_missing_str)
        num_local = int(count_local_str)
        num_remote = int(count_remote_str)
    except ValueError:
        logger.error(f"Invalid count parameter: {count_new_str}")
        return web.json_response({"error": "Invalid count parameter"}, status=400)
    
    # Calculate estimated seconds
    estimated_long_seconds = 1.85 * num_remote  # 1.85 seconds per LoRA
    estimated_short_seconds = 0.6 * num_local
    estimated_super_short_seconds = 0.2 * num_missing
    estimated_seconds = estimated_long_seconds + estimated_short_seconds + estimated_super_short_seconds

    # Determine estimated_time_minutes string
    if estimated_seconds < 60:
        estimated_time = "Less than 1 minute"
    else:
        # Calculate hours, minutes, and seconds
        hours = int(estimated_seconds // 3600)
        remaining_seconds = estimated_seconds % 3600
        minutes = int(remaining_seconds // 60)
        seconds = int(remaining_seconds % 60)

        # Construct the formatted time string
        time_parts = []
        if hours > 0:
            time_parts.append(f"{hours} hour{'s' if hours > 1 else ''}")
        if minutes > 0:
            time_parts.append(f"{minutes} minute{'s' if minutes > 1 else ''}")
        if seconds > 0 or (hours == 0 and minutes == 0):
            time_parts.append(f"{seconds} second{'s' if seconds > 1 else ''}")

        estimated_time = ", ".join(time_parts)

    logger.debug(f"Estimated processing time: ({estimated_time})")

    # Prepare and return JSON response
    return web.json_response({
        "total_unprocessed_loras": num_unprocessed,
        "new_loras": num_new,
        "moved_loras": num_moved,
        "missing_loras": num_missing,
        "local_loras": num_local,
        "remote_loras": num_remote,
        "estimated_time_seconds": round(estimated_seconds, 2),
        "estimated_time_minutes": estimated_time
    })

@PromptServer.instance.routes.get("/lora_sidebar/is_processing")
async def is_processing_handler(request):
    """Endpoint to check if LoRA processing is currently running."""
    return web.json_response({"is_processing": is_processing})

@PromptServer.instance.routes.get("/lora_sidebar/process")
async def process_loras(request):
    global is_processing, LORA_FILE_INFO, CACHE_SETTINGS

    # Get actual user settings as soon as we can
    settings = PromptServer.instance.user_manager.settings.get_settings(request)
    CACHE_SETTINGS.update({
        'sortMethod': settings.get("LoRA Sidebar.General.sortMethod", 'AlphaAsc'),
        'sortModels': settings.get("LoRA Sidebar.General.sortModels", 'None'),
        'tagSource': settings.get("LoRA Sidebar.General.tagSource", 'CivitAI'),
        'customTags': settings.get("LoRA Sidebar.General.customTags", "").split(','),
        'catNew': settings.get("LoRA Sidebar.General.catNew", True),
        'nsfwFolder': settings.get("LoRA Sidebar.NSFW.nsfwFolder", True),
        'nsfwString': settings.get("LoRA Sidebar.NSFW.folderString", 'NSFW')
    })
    
    # Check if processing is already in progress
    if is_processing:
        return web.json_response({
            "status": "Processing already in progress",
            "processed_count": 0,
            "total_count": 0,
            "skipped_count": 0
        }, status=400)

    is_processing = True

    try:
        # Check if we have the unprocessed data
        unprocessed_info = LoraDataStore.get_data()
        
        if unprocessed_info is None:
            # If not, we need to call get_unprocessed_count
            logger.info("Unprocessed data not found, calling get_unprocessed_count")
            unprocessed_response = await get_unprocessed_count(request) # can remove later?
            unprocessed_info = LoraDataStore.get_data()

        if unprocessed_info is None:
            raise ValueError("Failed to retrieve unprocessed LoRAs data")

        logger.info(f"Unprocessed info in process_loras: {unprocessed_info}")

        new_loras = unprocessed_info.get('new_loras', [])
        moved_loras = unprocessed_info.get('moved_loras', [])
        missing_loras = unprocessed_info.get('missing_loras', [])

        processed_count = 0
        skipped_count = 0
        total_count = len(new_loras) + len(moved_loras) + len(missing_loras)

        # Path to the processed LoRAs JSON file
        processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")

        # Load existing processed LoRAs
        if os.path.exists(processed_loras_file):
            with io.open(processed_loras_file, "r", encoding="utf-8") as f:
                try:
                    processed_loras = json.load(f)
                    if not isinstance(processed_loras, dict):
                        logger.warning("processed_loras.json is malformed. Expected a dictionary.")
                        processed_loras = {
                            "version": PROCESSED_LORAS_VERSION,
                            "loras": [],
                            "favorites": []
                        }
                except json.JSONDecodeError:
                    logger.error("Error decoding processed_loras.json. Starting with empty data.")
                    processed_loras = {
                        "version": PROCESSED_LORAS_VERSION,
                        "loras": [],
                        "favorites": []
                    }
        else:
            processed_loras = {
                "version": PROCESSED_LORAS_VERSION,
                "loras": [],
                "favorites": []
            }
            logger.info("No processed_loras.json found. Starting with empty data.")

        logger.info(f"Found {len(new_loras)} new LoRAs, {len(moved_loras)} moved LoRAs, and {len(missing_loras)} missing LoRAs to process.")

        async with aiohttp.ClientSession() as session:

            # Process both new and moved LoRAs
            loras_to_process = new_loras + moved_loras  # Combine both lists
            # Process new LoRAs
            for lora_file in loras_to_process:
                filename = lora_file #should remove i think?
                base_filename = lora_file
                lora_folder = os.path.join(LORA_DATA_DIR, base_filename)
                
                # Check if LoRA is already processed and up to date
                info_json_path = os.path.join(lora_folder, "info.json")
                if os.path.exists(info_json_path):
                    needs_reprocess = False
                    try:
                        with open(info_json_path, "r", encoding="utf-8") as f:
                            info_data = json.load(f)
                        
                        # Check if info.json version is current
                        if not info_data.get('info_version') or info_data.get('info_version') < PROCESSED_LORAS_VERSION:
                            needs_reprocess = True
                            logger.info(f"Found outdated info.json (version: {info_data.get('info_version', 'none')} -> {PROCESSED_LORAS_VERSION}) for {filename}, reprocessing")
                        
                    except Exception as e:
                        logger.error(f"Error checking info.json version for {filename}: {str(e)}")
                        logger.info(f"Will reprocess {filename} due to error checking version")
                        needs_reprocess = True

                    # Handle moved files
                    lora_info = LORA_FILE_INFO.get(base_filename)
                    if lora_info:
                        new_path = lora_info['path']
                        new_subdir = get_subdir(new_path)
                        path_updated = False
                        
                        try:
                            # Check if the LoRA exists in processed_loras.json
                            existing_entry = next((item for item in processed_loras["loras"] 
                                                if item.get("filename") == base_filename), None)
                            
                            # Update processed_loras.json if needed
                            if existing_entry is None:
                                processed_loras["loras"].append({
                                    "filename": base_filename,
                                    "path": new_path
                                })
                                path_updated = True
                                logger.info(f"Added new entry for moved LoRA {base_filename}: {new_path}")
                            elif existing_entry.get("path") != new_path:
                                existing_entry["path"] = new_path
                                path_updated = True
                                logger.info(f"Updated path for moved LoRA {base_filename}: {new_path}")

                            # If the path was updated, also update info.json
                            if path_updated:
                                # Read current info.json
                                with open(info_json_path, "r", encoding="utf-8") as f:
                                    info_data = json.load(f)
                                
                                needs_update = False
                                
                                # Check if we need to update metadata source
                                if info_data.get("local_metadata"):
                                    new_civitai_info = f"{os.path.splitext(new_path)[0]}.civitai.info"
                                    if not os.path.exists(new_civitai_info):
                                        info_data["local_metadata"] = False
                                        needs_update = True
                                        needs_reprocess = True
                                        logger.info(f"External metadata not found at new location for {base_filename}, switching to internal")
                                
                                # Update path and subdir if needed
                                if info_data.get("path") != new_path or info_data.get("subdir") != new_subdir:
                                    info_data["path"] = new_path
                                    info_data["subdir"] = new_subdir
                                    needs_update = True
                                    logger.info(f"Updated path/subdir in info.json for {base_filename}")
                                
                                # Write updates if needed
                                if needs_update:
                                    with open(info_json_path, "w", encoding="utf-8") as f:
                                        json.dump(info_data, f, indent=4)
                                        logger.info(f"Saved updated info.json for moved LoRA: {base_filename}")

                                # Save processed_loras.json immediately after updating
                                if os.path.exists(processed_loras_file):
                                    with open(processed_loras_file, "r", encoding="utf-8") as f:
                                        existing_data = json.load(f)
                                    
                                    # Update the specific entry in existing_data
                                    existing_lora = next((item for item in existing_data["loras"] 
                                                    if item.get("filename") == base_filename), None)
                                    if existing_lora:
                                        existing_lora["path"] = new_path
                                    else:
                                        existing_data["loras"].append({
                                            "filename": base_filename,
                                            "path": new_path
                                        })
                                    
                                    existing_data = validate_processed_loras(existing_data)
                                    with open(processed_loras_file, 'w', encoding="utf-8") as f:
                                        json.dump(existing_data, f, indent=4, ensure_ascii=False)
                                    logger.info(f"Updated processed_loras.json for {base_filename}")
                                
                                # Handle move completion
                                if base_filename in moved_loras:
                                    moved_loras.remove(base_filename)
                                    processed_count += 1
                                    progress = int(((processed_count + skipped_count) / total_count) * 100)
                                    await PromptServer.instance.send_json("lora_process_progress", {
                                        "progress": progress,
                                        "completed": processed_count + skipped_count,
                                        "total": total_count
                                    })
                                    logger.info(f"Completed move processing for {base_filename}")
                            
                        except Exception as e:
                            logger.error(f"Error updating info for moved LoRA {base_filename}: {str(e)}")
                            needs_reprocess = True  # Force reprocess if we had an error
                    
                    # Only skip if we don't need to reprocess and haven't moved
                    if not needs_reprocess:
                        skipped_count += 1
                        progress = int(((processed_count + skipped_count) / total_count) * 100)
                        await PromptServer.instance.send_json("lora_process_progress", {
                            "progress": progress,
                            "completed": processed_count + skipped_count,
                            "total": total_count
                        })
                        logger.info(f"Skipping already processed LoRA (current version): {filename}")
                        continue
                
                try:
                    # Process LoRA without creating the folder first
                    logger.info(f"Processing {filename}")

                    # Get the file path from LORA_FILE_INFO - let's add proper error handling here
                    if LORA_FILE_INFO is None:
                        raise ValueError(f"LORA_FILE_INFO is None when processing {filename}")
                                    
                    if LORA_FILE_INFO is not None:
                        logger.info(f"Looking for base_filename: {base_filename}")

                    # Get the file path from LORA_FILE_INFO
                    lora_info = LORA_FILE_INFO.get(base_filename)
                    if not lora_info:
                        raise ValueError(f"No entry in LORA_FILE_INFO for {base_filename}. Available keys: {list(LORA_FILE_INFO.keys())[:5]}")
                    
                    file_path = lora_info['path']
                    has_local_metadata = False  # Initialize

                    # Check for local metadata first
                    version_info = await check_local_info(file_path)
                    if version_info:
                        has_local_metadata = True  # Set flag if we found local metadata
                        logger.info("Got version info from local metadata")
                    else:
                        # If no local metadata, proceed with CivitAI API calls
                        file_hash = await hash_file(file_path)
                        version_info = await fetch_version_info(session, file_hash)
                        logger.info("Got version info from CivitAI")

                    # Calculate subdir, handling symlink issues and cross-drive paths
                    subdir = get_subdir(file_path)
                    
                    if version_info:
                        # Prepare data to save
                        info_to_save = {
                            "name": (version_info.get('model', {}).get('name') or version_info.get('name') or filename),
                            "modelId": version_info.get('modelId'),
                            "versionId": version_info.get('id'),
                            "versionName": version_info.get('name'),
                            "tags": [],
                            "trained_words": version_info.get('trainedWords', []),
                            "baseModel": version_info.get('baseModel'),
                            "images": [],
                            "nsfw": version_info.get('model', {}).get('nsfw', False),
                            "nsfwLevel": 0,
                            "version_desc": version_info.get('description'),
                            "reco_weight": 1,
                            "model_desc": version_info.get('model', {}).get('description'),
                            "type": version_info.get('model', {}).get('type'),
                            "createdDate": format_date(version_info.get('createdAt')) or datetime.now().strftime('%Y-%m-%d'),
                            "updatedDate": format_date(version_info.get('updatedAt')),
                            "subdir": subdir,
                            "path": file_path,
                            "local_metadata": has_local_metadata,
                            "info_version": PROCESSED_LORAS_VERSION,
                            "user_edits": []
                        }
                        
                        # Fetch model info if available and we're not using local metadata
                        model_id = info_to_save["modelId"]
                        if model_id and not has_local_metadata:
                            model_info = await fetch_model_info(session, model_id)
                            if model_info:
                                info_to_save["tags"] = model_info.get('tags', [])
                                info_to_save["nsfwLevel"] = model_info.get('nsfwLevel', 0)
                                info_to_save["model_desc"] = model_info.get('description')

                        # Get custom images only for local metadata
                        custom_images = []
                        if has_local_metadata:
                            logger.info(f"Looking for custom images for local metadata LoRA: {filename}")
                            custom_images = find_custom_images(file_path, base_filename)
                            logger.info(f"Found {len(custom_images)} custom images")
                        
                        # Process remote images from version_info
                        remote_images = []
                        for image in version_info.get('images', []):
                            meta = image.get('meta', {})  # Default to empty dict if None
                            remote_images.append({
                                "url": image.get('url'),
                                "type": image.get('type'),
                                "nsfwLevel": image.get('nsfwLevel', 0),
                                "hasMeta": image.get('hasMeta', False),
                                "prompt": meta.get('prompt') if meta else None,  # Guard against None
                                "blurhash": image.get('hash')
                            })
                        
                        # Combine custom images first, then remote images
                        info_to_save['images'] = custom_images + remote_images

                        # Handle trained_words
                        trained_words = version_info.get('trainedWords', [])
                        if isinstance(trained_words, list):
                            if len(trained_words) == 1 and ',' in trained_words[0]:
                                # Split the comma-separated string into a list
                                info_to_save["trained_words"] = [word.strip() for word in trained_words[0].split(',') if word.strip()]
                            else:
                                # Already a list, just use it as is
                                info_to_save["trained_words"] = trained_words
                        elif isinstance(trained_words, str):
                            # If it's a single string, split it by commas
                            info_to_save["trained_words"] = [word.strip() for word in trained_words.split(',') if word.strip()]
                        else:
                            # Fallback to an empty list if it's neither a list nor a string
                            info_to_save["trained_words"] = []
                        
                        # Download the first image as preview
                        has_local_images = version_info.get('has_local_images', False) if has_local_metadata else False
                        if info_to_save['images']:
                            if not has_local_images:  # Download if not using local images or not local metadata
                                preview_path = os.path.join(LORA_DATA_DIR, filename, "preview")
                                os.makedirs(os.path.dirname(preview_path), exist_ok=True)  
                                preview_filename = await download_image(session, info_to_save['images'][0]['url'], preview_path)
                                if preview_filename:
                                    logger.info(f"Saved preview image as {preview_filename}")
                            else:
                                logger.info("Using existing local preview image")
                        else:
                            # Only copy placeholder if no local images
                            if not has_local_images:
                                logger.info("No images available and no local images - copying placeholder")
                                await copy_placeholder_as_preview(base_filename)
                            else:
                                logger.info("No images in metadata but using local images")
                        
                        # Create the LoRA folder after successful processing
                        os.makedirs(lora_folder, exist_ok=True)
                        
                        # Save information to a JSON file
                        info_file_path = os.path.join(lora_folder, "info.json")
                        with open(info_file_path, "w", encoding="utf-8") as f:
                            json.dump(info_to_save, f, indent=4)
                    
                    else:
                        logger.info(f"Failed to fetch info for {filename}, treating it as a custom LoRA.")

                        custom_images = []  # Initialize first
                        try:
                            custom_images = find_custom_images(file_path, base_filename)
                            logger.info(f"Found {len(custom_images)} custom images for custom LoRA")
                        except Exception as e:
                            logger.error(f"Error finding custom images: {str(e)}")
                            custom_images = []  # Ensure we have an empty list if something fails

                        info_to_save = {
                            "name": filename,  # Use filename as the name for custom LoRAs
                            "modelId": None,
                            "versionId": None,
                            "versionName": None,
                            "tags": [],
                            "trained_words": [],
                            "baseModel": "custom",  # Custom for dropdown
                            "images": custom_images,
                            "nsfw": False,
                            "nsfwLevel": 0,
                            "version_desc": "Custom Lora",
                            "reco_weight": 1,
                            "model_desc": None,
                            "type": None,
                            "createdDate": datetime.now().strftime('%Y-%m-%d'),
                            "updatedDate": datetime.now().strftime('%Y-%m-%d'),
                            "subdir": subdir,
                            "path": file_path,
                            "local_metadata": True,
                            "info_version": PROCESSED_LORAS_VERSION,  # don't really need this for custom loras
                            "user_edits": []
                        }

                        # Handle preview image for custom LoRA
                        if custom_images:
                            try:
                                logger.info("Using first custom image as preview")
                                preview_path = os.path.join(LORA_DATA_DIR, filename, "preview")
                                os.makedirs(os.path.dirname(preview_path), exist_ok=True)
                                # For custom images, copy the first one as preview
                                first_image = custom_images[0]['name']
                                source_path = os.path.join(os.path.dirname(file_path), first_image)
                                if os.path.exists(source_path):
                                    ext = os.path.splitext(first_image)[1]
                                    shutil.copy2(source_path, os.path.join(preview_path + ext))
                                    logger.info(f"Copied custom image as preview: {first_image}")
                            except Exception as e:
                                logger.error(f"Error setting preview image: {str(e)}")
                                await copy_placeholder_as_preview(base_filename)
                        else:
                            # Copy the placeholder image as preview
                            logger.info("No custom images found - copying placeholder")
                            await copy_placeholder_as_preview(base_filename)

                        # Create the LoRA folder
                        os.makedirs(lora_folder, exist_ok=True)

                        # Save the minimal info.json
                        info_file_path = os.path.join(lora_folder, "info.json")
                        with open(info_file_path, "w", encoding="utf-8") as f:
                            json.dump(info_to_save, f, indent=4)

                    logger.info(f"Processed {filename}")

                    # Add to cache
                    if LORA_CACHE.get('ordered_loras') is not None:
                        info_to_save['id'] = base_filename  # Make sure ID is set
                        info_to_save['favorite'] = base_filename in processed_loras.get('favorites', [])
                        
                        # Remove any existing entry first (in case of reprocessing)
                        LORA_CACHE['ordered_loras'] = [
                            item for item in LORA_CACHE['ordered_loras'] 
                            if item['id'] != base_filename
                        ]
                        
                        # Add new entry
                        LORA_CACHE['ordered_loras'].append(info_to_save)
                        
                        # Resort if needed
                        if len(LORA_CACHE['ordered_loras']) > 1:
                            # Get  user settings for sorting
                            settings = PromptServer.instance.user_manager.settings.get_settings(request)
                            sort_metadata = await get_lora_sort_metadata()
                            LORA_CACHE['ordered_loras'] = await sort_loras_with_categories(
                                LORA_CACHE['ordered_loras'],
                                settings,
                                processed_loras.get('favorites', []),
                                sort_metadata
                            )
                            
                        # Update category counts
                        manage_category_counts("calculate", 
                            loras=LORA_CACHE['ordered_loras'],
                            settings=CACHE_SETTINGS
                        )

                    processed_count += 1
                    processed_loras["loras"].append({
                        "filename": base_filename,
                        "path": file_path  # Include the path here
                    })
                    processed_loras = validate_processed_loras(processed_loras)
                    with open(processed_loras_file, 'w', encoding="utf-8") as f:
                        json.dump(processed_loras, f, indent=4, ensure_ascii=False)
                
                except Exception as e:
                    logger.error(f"Error processing {filename}: {str(e)}")
                    # Remove the folder if it was partially created
                    if os.path.exists(lora_folder):
                        shutil.rmtree(lora_folder)
                
                # Send progress update
                progress = int(((processed_count + skipped_count) / total_count) * 100)
                await PromptServer.instance.send_json("lora_process_progress", {
                    "progress": progress,
                    "completed": processed_count + skipped_count,
                    "total": total_count
                })

            # Handle missing LoRAs
            for missing_lora_name in missing_loras:
                try:
                    lora_folder = os.path.join(LORA_DATA_DIR, missing_lora_name)
                    # Remove the folder if it exists
                    if os.path.exists(lora_folder):
                        shutil.rmtree(lora_folder)
                        logger.info(f"Removed folder for missing LoRA: {missing_lora_name}")

                    # Read current data to preserve version and favorites
                    existing_data = {
                        "version": PROCESSED_LORAS_VERSION,
                        "loras": [],
                        "favorites": []
                    }
                    if os.path.exists(processed_loras_file):
                        with open(processed_loras_file, "r", encoding="utf-8") as f:
                            existing_data = json.load(f)
                    
                    # Update loras list - remove the missing one
                    existing_data["loras"] = [
                        lora for lora in existing_data["loras"] 
                        if lora.get("filename") != missing_lora_name
                    ]
                    
                    # Also remove from favorites if present
                    if missing_lora_name in existing_data.get("favorites", []):
                        existing_data["favorites"].remove(missing_lora_name)
                    
                    # Update cache if it exists
                    if LORA_CACHE.get('ordered_loras'):
                        LORA_CACHE['ordered_loras'] = [
                            lora for lora in LORA_CACHE['ordered_loras']
                            if lora.get('id') != missing_lora_name
                        ]
                    
                    # Save updated data
                    with open(processed_loras_file, "w", encoding="utf-8") as f:
                        json.dump(existing_data, f, indent=4, ensure_ascii=False)
                    
                    logger.info(f"Removed {missing_lora_name} from processed_loras.json")
                    processed_count += 1
                    
                except Exception as e:
                    logger.error(f"Error handling missing LoRA {missing_lora_name}: {str(e)}")
                    skipped_count += 1

                # Send progress update
                progress = int(((processed_count + skipped_count) / total_count) * 100)
                await PromptServer.instance.send_json("lora_process_progress", {
                    "progress": progress,
                    "completed": processed_count + skipped_count,
                    "total": total_count
                })

        if LORA_CACHE.get('ordered_loras'):
            # Get proper user settings
            settings = PromptServer.instance.user_manager.settings.get_settings(request)
            sort_metadata = await get_lora_sort_metadata()
            
            # Resort entire cache with proper settings
            LORA_CACHE['ordered_loras'] = await sort_loras_with_categories(
                LORA_CACHE['ordered_loras'],
                settings,
                processed_loras.get('favorites', []),
                sort_metadata
            )
            
            # Final category calculation with proper settings
            category_info = manage_category_counts("calculate",
                loras=LORA_CACHE['ordered_loras'],
                settings=settings
            )
            
            response_data = {
                "status": "Processing complete",
                "processed_count": processed_count,
                "total_count": total_count,
                "skipped_count": skipped_count,
                "categoryInfo": category_info
            }
        else:
            response_data = {
                "status": "Processing complete",
                "processed_count": processed_count,
                "total_count": total_count,
                "skipped_count": skipped_count
            }

    finally:
        is_processing = False  # Ensure flag is reset when processing finishes
        LoraDataStore.clear_data()
        # disable the refresh all setting after processing
        setting_id = "LoRA Sidebar.General.refreshAll"
        settings = PromptServer.instance.user_manager.settings.get_settings(request)
        settings[setting_id] = False
        PromptServer.instance.user_manager.settings.save_settings(request, settings)
        refresh_setting = settings.get("LoRA Sidebar.General.refreshAll")
        logger.info(f"Current refresh setting value: {refresh_setting}")

    return web.json_response(response_data)


@PromptServer.instance.routes.get("/lora_sidebar/data")
async def get_lora_data(request):
    # Get request parameters
    offset = int(request.query.get('offset', 0))
    limit = int(request.query.get('limit', 500))

    # Make sure we don't go over actual total lora size
    #totalLoras = len(LORA_CACHE['ordered_loras'])
    #logger.error('Initial request limit', limit)
    #if limit > totalLoras:
    #    limit = totalLoras - 1
    #    logger.error('NEW request limit', limit)
    
    # Get settings and metadata
    settings = get_user_settings(request)
    sort_metadata = await get_lora_sort_metadata()

    # Cache check if we need to rebuild/resort cache
    needs_resort = False
    needs_rebuild = False

    if not LORA_CACHE.get('ordered_loras'):
        logger.info("No cache found, will rebuild")
        needs_rebuild = True
    else:
        # Settings that require rebuild (modify core data)
        rebuild_keys = ['nsfwFolder', 'nsfwString']
        for key in rebuild_keys:
            if settings.get(key) != CACHE_SETTINGS.get(key):
                logger.info(f"Setting requiring rebuild changed: {key} {CACHE_SETTINGS.get(key)} -> {settings.get(key)}")
                needs_rebuild = True
                break

        # Settings that only need resort (presentation changes)
        if not needs_rebuild:  # Only check if we don't already need rebuild
            resort_keys = ['sortMethod', 'sortModels', 'tagSource']
            for key in resort_keys:
                if settings.get(key) != CACHE_SETTINGS.get(key):
                    logger.info(f"Sort setting changed: {key} {CACHE_SETTINGS.get(key)} -> {settings.get(key)}")
                    needs_resort = True
                    break
            
            # Custom tags check
            if settings.get('tagSource') == 'Custom' and settings.get('customTags') != CACHE_SETTINGS.get('customTags'):
                logger.info("Custom tags changed")
                needs_resort = True
   
    # Load favorites
    favorites = []
    processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
    if os.path.exists(processed_loras_file):
        with open(processed_loras_file, "r", encoding="utf-8") as f:
            try:
                processed_loras = json.load(f)
                favorites = processed_loras.get('favorites', [])
            except json.JSONDecodeError:
                logger.error("Error reading processed_loras.json")
        
    if needs_rebuild:
        lora_data = []

        # Load LoRA data
        all_folders = [folder for folder in os.listdir(LORA_DATA_DIR)
                    if os.path.isdir(os.path.join(LORA_DATA_DIR, folder))]
                    
        for folder in all_folders:
            info_file = os.path.join(LORA_DATA_DIR, folder, "info.json")
            if os.path.exists(info_file):
                with open(info_file, "r", encoding="utf-8") as f:
                    try:
                        data = json.load(f)
                        data['id'] = folder
                        data['favorite'] = folder in favorites
                    
                        # Add NSFW folder check
                        nsfw_folder = settings.get('nsfwFolder', True)
                        if nsfw_folder and 'path' in data:
                            path_lower = data['path'].lower()
                            nsfw_string = settings.get('nsfwString', 'NSFW').lower()
                            if nsfw_string in path_lower:
                                logger.info(f"Setting NSFW flag for {folder} due to path: {data['path']}")
                                data['nsfw'] = True

                        # Get filename and path
                        if folder in LORA_FILE_INFO:
                            data['filename'] = LORA_FILE_INFO[folder]['filename']
                            data['path'] = LORA_FILE_INFO[folder]['path']
                        else:
                            data['filename'] = f"{folder}.safetensors"
                            data['path'] = ""
                        lora_data.append(data)
                    except json.JSONDecodeError:
                        logger.error(f"Error reading {info_file}. Skipping.")
    
        # Pre-sort all data
        ordered_loras = await sort_loras_with_categories(lora_data, settings, favorites, sort_metadata)
        LORA_CACHE['ordered_loras'] = ordered_loras

        # After rebuild, update cache settings
        CACHE_SETTINGS.update({
            'sortMethod': settings.get('sortMethod'),
            'sortModels': settings.get('sortModels'),
            'tagSource': settings.get('tagSource'),
            'customTags': settings.get('customTags', []),
            'catNew': settings.get('catNew', True),
            'nsfwFolder': settings.get('nsfwFolder', True),
            'nsfwString': settings.get("nsfwString", 'NSFW')
        })

    elif needs_resort:
        logger.info("Resorting existing cache")
        # Just resort existing data
        LORA_CACHE['ordered_loras'] = await sort_loras_with_categories(
            LORA_CACHE['ordered_loras'], 
            settings, 
            favorites, 
            sort_metadata
        )

        # Update cache settings
        CACHE_SETTINGS.update({
            'sortMethod': settings.get('sortMethod'),
            'sortModels': settings.get('sortModels'),
            'tagSource': settings.get('tagSource'),
            'customTags': settings.get('customTags', []),
            'catNew': settings.get('catNew', True),
            'nsfwFolder': settings.get('nsfwFolder', True),
            'nsfwString': settings.get("nsfwString", 'NSFW')
        })

    # Get all loras from cache
    all_loras = LORA_CACHE.get('ordered_loras', [])

    # Separate loras into priority groups
    favorites_list = [lora for lora in all_loras if lora['favorite']]
    new_items = []
    if settings.get('catNew'):
        new_items = [lora for lora in all_loras if not lora['favorite'] and lora.get('is_new')]

    def sort_category(cat):
        """
        Custom sort function that:
        1. Forces lowercase first for consistent sorting
        2. Handles numeric prefixes properly
        3. Preserves natural number ordering
        """
        # Force lowercase immediately
        cat = str(cat).strip().lower()
        
        # Split the string into numeric and non-numeric parts
        parts = []
        current_part = ""
        current_is_digit = False
        
        for char in cat:
            is_digit = char.isdigit()
            if current_part and is_digit != current_is_digit:
                # Type changed, store the current part
                if current_is_digit:
                    parts.append(int(current_part))
                else:
                    parts.append(current_part)  # Already lowercase
                current_part = ""
            current_part += char
            current_is_digit = is_digit
            
        # Add the last part
        if current_part:
            if current_is_digit:
                parts.append(int(current_part))
            else:
                parts.append(current_part)  # Already lowercase
                
        return parts
    
    # Group remaining loras by category
    remaining_by_category = {}
    for lora in all_loras:
        if not lora['favorite'] and (not lora.get('is_new') or not settings.get('catNew')):
            cat = str(lora.get('category', 'Unsorted')).lower()
            if cat not in remaining_by_category:
                remaining_by_category[cat] = []
            remaining_by_category[cat].append(lora)
    
    # Create ordered list with priorities
    ordered_categories = sorted(remaining_by_category.keys())
    prioritized_loras = favorites_list + new_items
    #Debug print order
    logger.info("Category order:")
    for idx, cat in enumerate(ordered_categories[:10]):
        logger.info(f"{idx + 1}. {cat} ({len(remaining_by_category[cat])} items)")
    
    # Add category-based loras in order
    for category in ordered_categories:
        prioritized_loras.extend(remaining_by_category[category])
    # Debug print the first few non-favorite, non-new loras
    start_idx = len(favorites_list) + len(new_items)
    logger.info("\nFirst 10 category loras being sent:")
    for idx, lora in enumerate(prioritized_loras[start_idx:start_idx+10]):
        logger.info(f"{idx + 1}. Category: {lora.get('category', 'Unknown')} | Name: {lora.get('name', lora.get('filename', 'Unknown'))}")
    
    # Apply pagination
    start_idx = offset
    end_idx = offset + limit
    paginated_loras = LORA_CACHE['ordered_loras'][start_idx:end_idx]
    # Also debug print what's actually being sent in this chunk
    logger.info(f"\nSending chunk from {start_idx} to {end_idx} ({len(paginated_loras)} items)")
    logger.info("First 10 items in this chunk:")
    for idx, lora in enumerate(paginated_loras[:10]):
        logger.info(f"{idx + 1}. Category: {lora.get('category', 'Unknown')} | " 
                   f"Name: {lora.get('name', lora.get('filename', 'Unknown'))} | "
                   f"{'(Favorite)' if lora.get('favorite') else '(New)' if lora.get('is_new') else ''}")

    # Clear sent tracking on initial load
    if offset == 0:
        LORA_CACHE['sent_loras'] = set()
    
    # Track what we're sending
    LORA_CACHE['sent_loras'].update(lora['id'] for lora in paginated_loras)

    # Calculate category counts for all data
    category_counts = manage_category_counts("calculate",
        loras=all_loras,
        paginated_loras=paginated_loras,
        settings=settings
    )
   
    return web.json_response({
        "loras": paginated_loras,
        "favorites": favorites if offset == 0 else [],
        "hasMore": end_idx < len(LORA_CACHE['ordered_loras']),
        "totalCount": len(LORA_CACHE['ordered_loras']),
        "categoryInfo": category_counts
    })


@PromptServer.instance.routes.post("/lora_sidebar/toggle_favorite")
async def toggle_favorite(request):
    data = await request.json()
    lora_id = data.get('id')
    logger.info(f"Toggle favorite request for LoRA ID: {lora_id}")
   
    # Update processed_loras.json
    processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
    if os.path.exists(processed_loras_file):
        with open(processed_loras_file, "r", encoding="utf-8") as f:
            try:
                processed_loras = json.load(f)
            except json.JSONDecodeError:
                processed_loras = {"favorites": []}
    else:
        processed_loras = {"favorites": []}
   
    if 'favorites' not in processed_loras:
        processed_loras['favorites'] = []
   
    # Toggle status
    is_favorite = lora_id in processed_loras['favorites']
    logger.info(f"LoRA current favorite status: {is_favorite}")
   
    if is_favorite:
        processed_loras['favorites'].remove(lora_id)
        logger.info(f"Removed {lora_id} from favorites")
    else:
        processed_loras['favorites'].append(lora_id)
        logger.info(f"Added {lora_id} to favorites")

    # Get the lora's current category before updating
    old_category = None
    new_category = None
    if LORA_CACHE['ordered_loras']:
        for lora in LORA_CACHE['ordered_loras']:
            if lora['id'] == lora_id:
                old_category = 'Favorites' if is_favorite else lora['category']
                new_category = lora['category'] if is_favorite else 'Favorites'
                lora['favorite'] = not is_favorite
                break

    # Update category counts
    category_info = manage_category_counts("update",
        old_category=old_category,
        new_category=new_category
    )
   
    # Save persistent data
    with open(processed_loras_file, 'w', encoding="utf-8") as f:
        json.dump(processed_loras, f, indent=4)
   
    return web.json_response({
        "status": "success",
        "categoryInfo": category_info
    })

@PromptServer.instance.routes.post("/lora_sidebar/set_preview")
async def set_preview_image(request):
    try:
        data = await request.json()
        lora_id = data.get('id')
        image_url = data.get('url')
        
        if not lora_id or not image_url:
            return web.json_response({"error": "Missing parameters"}, status=400)
        
        # Handle internal URLs (custom images)
        if image_url.startswith('/lora_sidebar/custom_image/'):
            try:
                # Parse the filename from the URL
                parts = image_url.split('/')
                if len(parts) >= 5:  # Ensure we have enough parts
                    source_filename = parts[-1]  # Get the last part as filename
                    
                    # Source path (where the custom image is stored)
                    source_path = os.path.join(LORA_DATA_DIR, lora_id, source_filename)
                    
                    if not os.path.exists(source_path):
                        return web.json_response({"error": "Source image not found"}, status=404)
                    
                    # Remove any existing preview files
                    preview_dir = os.path.join(LORA_DATA_DIR, lora_id)
                    for filepath in glob.glob(os.path.join(preview_dir, 'preview.*')):
                        os.remove(filepath)
                    
                    # Determine extension from source file
                    ext = os.path.splitext(source_filename)[1]
                    preview_path = os.path.join(preview_dir, f"preview{ext}")
                    
                    # Copy the file
                    shutil.copy2(source_path, preview_path)
                    
                    # Generate a unique version
                    preview_version = str(int(time.time()))
                    
                    return web.json_response({
                        "status": "success",
                        "preview_version": preview_version
                    })
            except Exception as e:
                logger.error(f"Error setting preview from internal image: {str(e)}")
                return web.json_response({"error": str(e)}, status=500)
        
        # Handle external URLs (original code for external images)
        async with aiohttp.ClientSession() as session:
            async with session.get(image_url) as response:
                if response.status == 200:
                    content_type = response.headers.get('Content-Type', '')
                    ext = mimetypes.guess_extension(content_type) or '.jpg'
                    
                    # Remove any existing preview files
                    preview_dir = os.path.join(LORA_DATA_DIR, lora_id)
                    for filepath in glob.glob(os.path.join(preview_dir, 'preview.*')):
                        os.remove(filepath)
                    
                    # Save the new preview image
                    preview_path = os.path.join(preview_dir, f"preview{ext}")
                    with open(preview_path, 'wb') as f:
                        f.write(await response.read())
                    
                    # Generate a unique version for just this preview
                    preview_version = str(int(time.time()))
                    return web.json_response({
                        "status": "success",
                        "preview_version": preview_version
                    })
                else:
                    return web.json_response({"error": "Failed to fetch image"}, status=400)
                    
    except Exception as e:
        logger.error(f"Error setting preview image: {str(e)}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/lora_sidebar/refresh/{version_id}")
async def refresh_lora(request):
    version_id = request.match_info['version_id']
    processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")

    # Define the standard field order
    STANDARD_FIELD_ORDER = [
        "name",
        "modelId",
        "versionId",
        "versionName",
        "tags",
        "trained_words",
        "baseModel",
        "images",
        "nsfw",
        "nsfwLevel",
        "version_desc",
        "reco_weight",
        "model_desc",
        "type",
        "createdDate",
        "updatedDate",
        "subdir",
        "path",
        "local_metadata",
        "info_version",
        "user_edits"
    ]

    async with aiohttp.ClientSession() as session:
        try:
            # Find the existing LoRA folder based on version ID
            existing_lora_folder = None
            existing_info = None
            base_filename = None
            for folder in os.listdir(LORA_DATA_DIR):
                info_file_path = os.path.join(LORA_DATA_DIR, folder, "info.json")
                if os.path.exists(info_file_path):
                    with open(info_file_path, "r", encoding="utf-8") as f:
                        folder_info = json.load(f)
                        if str(folder_info.get("versionId")) == str(version_id):
                            existing_lora_folder = os.path.join(LORA_DATA_DIR, folder)
                            existing_info = folder_info
                            base_filename = folder
                            break

            if not existing_lora_folder or not existing_info:
                logger.warning(f"LoRA with version ID {version_id} not found.")
                return web.json_response({
                    "status": "error",
                    "message": f"LoRA with version ID {version_id} not found"
                }, status=404)
            
            # Cache user edits and custom images
            user_edits = existing_info.get('user_edits', [])
            existing_custom_images = [img for img in existing_info.get('images', []) 
                                    if img.get('custom') is True]

            # Check if this LoRA uses local metadata
            if existing_info.get("local_metadata"):
                version_info = await check_local_info(existing_info["path"])
                if not version_info:
                    return web.json_response({
                        "status": "error",
                        "message": "Local metadata file no longer exists"
                    }, status=400)
                
                # Also get remote info for images if needed
                if not version_info.get('images'):
                    remote_info = await fetch_version_info_by_id(session, version_id)
                    if remote_info and remote_info.get('images'):
                        version_info['images'] = remote_info['images']
            else:
                version_info = await fetch_version_info_by_id(session, version_id, skip_rate_limit=True)

            # Initialize updates dictionary
            updates = {}

            # Get modelId from either source
            model_id = version_info.get('modelId') or existing_info.get('modelId')
            
            # Only fetch model info if we need it and aren't using local metadata
            if model_id and not existing_info.get("local_metadata"):
                logger.info(f"Fetching model info for model ID: {model_id}")
                model_info = await fetch_model_info(session, model_id, skip_rate_limit=True)
                if model_info:
                    # Only update non-user-edited fields
                    if 'tags' not in user_edits and model_info.get('tags'):
                        updates['tags'] = model_info.get('tags', [])
                    if 'nsfwLevel' not in user_edits and model_info.get('nsfwLevel') is not None:
                        updates['nsfwLevel'] = model_info.get('nsfwLevel', 0)
                    if 'model_desc' not in user_edits and model_info.get('description'):
                        updates['model_desc'] = model_info.get('description')

            # Update fields only if they're not in user_edits
            if version_info:
                if 'name' not in user_edits:
                    new_name = version_info.get('model', {}).get('name', existing_info.get('name'))
                    if new_name and new_name != existing_info.get('name'):
                        updates['name'] = new_name

                if 'trained_words' not in user_edits:
                    new_trained_words = version_info.get('trainedWords', existing_info.get('trained_words'))
                    if new_trained_words and new_trained_words != existing_info.get('trained_words'):
                        if isinstance(new_trained_words, list):
                            if len(new_trained_words) == 1 and ',' in new_trained_words[0]:
                                # Split single entry with commas into multiple words
                                updates['trained_words'] = [word.strip() for word in new_trained_words[0].split(',') if word.strip()]
                            else:
                                # Already a proper list format, use as-is
                                updates['trained_words'] = new_trained_words
                        elif isinstance(new_trained_words, str):
                            # Single string - split it
                            updates['trained_words'] = [word.strip() for word in new_trained_words.split(',') if word.strip()]
                        else:
                            updates['trained_words'] = []

                if 'baseModel' not in user_edits:
                    new_base_model = version_info.get('baseModel')
                    if new_base_model and new_base_model != existing_info.get('baseModel'):
                        updates['baseModel'] = new_base_model

                if 'version_desc' not in user_edits:
                    new_description = version_info.get('description')
                    if new_description and new_description != existing_info.get('description'):
                        updates['description'] = new_description

            # Handle remote images
            new_remote_images = []
            for image in version_info.get('images', []):
                meta = image.get('meta', {})
                image_data = {
                    "url": image.get('url'),
                    "type": image.get('type'),
                    "nsfwLevel": image.get('nsfwLevel', 0),
                    "hasMeta": image.get('hasMeta', False),
                    "prompt": meta.get('prompt') if meta else None,
                    "blurhash": image.get('hash')
                }
                if image_data['url']:
                    new_remote_images.append(image_data)

            # Look for any new custom images
            if LORA_FILE_INFO.get(base_filename):
                file_path = LORA_FILE_INFO[base_filename]['path']
                current_custom_images = find_custom_images(file_path, base_filename)
                
                # Merge with existing custom images, avoiding duplicates
                existing_custom_urls = {img['url'] for img in existing_custom_images}
                new_custom_images = [img for img in current_custom_images 
                                   if img['url'] not in existing_custom_urls]
                
                if new_custom_images:
                    existing_custom_images.extend(new_custom_images)

            # Update images list
            updates['images'] = existing_custom_images + new_remote_images

            # Always check and update subdir if path has changed
            if LORA_FILE_INFO.get(base_filename):
                new_path = LORA_FILE_INFO[base_filename]['path']
                new_subdir = get_subdir(new_path)
                
                if new_path != existing_info.get('path') or new_subdir != existing_info.get('subdir'):
                    updates['path'] = new_path
                    updates['subdir'] = new_subdir
                    
                    # Update processed_loras.json with new path
                    if os.path.exists(processed_loras_file):
                        with open(processed_loras_file, 'r', encoding="utf-8") as f:
                            processed_loras = json.load(f)
                        
                        # Update the path in processed_loras
                        for lora in processed_loras.get('loras', []):
                            if lora.get('filename') == base_filename:
                                lora['path'] = new_path
                                break
                        
                        processed_loras = validate_processed_loras(processed_loras)
                        with open(processed_loras_file, 'w', encoding="utf-8") as f:
                            json.dump(processed_loras, f, indent=4, ensure_ascii=False)

            #Check for and update date fields
            if version_info:
                created_date = format_date(version_info.get('createdAt'))
                updated_date = format_date(version_info.get('updatedAt'))
                
                # If API version has valid date or existing date is invalid/missing, update it
                if (created_date != 'unknown' and created_date != existing_info.get('createdDate')) or \
                existing_info.get('createdDate') in [None, 'unknown']:
                    updates['createdDate'] = created_date if created_date != 'unknown' else datetime.now().strftime('%Y-%m-%d')
                    
                if (updated_date != 'unknown' and updated_date != existing_info.get('updatedDate')) or \
                existing_info.get('updatedDate') in [None, 'unknown']:
                    updates['updatedDate'] = updated_date if updated_date != 'unknown' else datetime.now().strftime('%Y-%m-%d')

            # If there are updates, apply them while preserving user edits
            if updates:
                logger.info(f"Applying updates to LoRA {existing_lora_folder}: {updates}")
                
                # Apply updates while preserving user edits
                for key, value in updates.items():
                    if key not in user_edits:  # Only update if not user-edited
                        existing_info[key] = value

                # Create new ordered dict using standard field order
                ordered_info = {}

                # First add all fields in standard order
                for field in STANDARD_FIELD_ORDER:
                    if field in existing_info:
                        ordered_info[field] = existing_info[field]
                
                # Then add any additional fields that might exist but aren't in standard order
                for key in existing_info:
                    if key not in ordered_info:
                        ordered_info[key] = existing_info[key]
                
                # Save updated information
                info_file_path = os.path.join(existing_lora_folder, "info.json")
                with open(info_file_path, "w", encoding="utf-8") as f:
                    json.dump(ordered_info, f, indent=4, ensure_ascii=False)

                # Update the cache using base_filename
                if LORA_CACHE.get('ordered_loras'):
                    for item in LORA_CACHE['ordered_loras']:
                        if item['id'] == base_filename:
                            item.update(ordered_info)
                            break
                
                category_info = manage_category_counts("calculate",
                    loras=LORA_CACHE['ordered_loras'],
                )

                return web.json_response({
                    "status": "success", 
                    "data": existing_info,
                    "updated_fields": list(updates.keys()),
                    "categoryInfo": category_info
                })
            else:
                logger.info(f"No updates required for LoRA with version ID {version_id}.")
                return web.json_response({
                    "status": "success", 
                    "message": "No updates required"
                })

        except Exception as e:
            logger.error(f"Error refreshing LoRA: {str(e)}")
            return web.json_response({
                "status": "error",
                "message": str(e)
            }, status=500)
        
@PromptServer.instance.routes.post("/lora_sidebar/refresh/{lora_id}")
async def refresh_lora(request):
    lora_id = request.match_info['lora_id']
    lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
    info_json_path = os.path.join(lora_folder, "info.json")

    if not os.path.exists(info_json_path):
        return web.json_response({"status": "error", "message": "LoRA not found"}, status=404)

    with open(info_json_path, "r", encoding="utf-8") as f:
        info_data = json.load(f)

    model_id = info_data.get("modelId")
    version_id = info_data.get("versionId")

    async with aiohttp.ClientSession() as session:
        try:
            # If no model or version ID, perform a hash lookup
            if not model_id or not version_id:
                logger.warning(f"No model or version ID found for {lora_id}, performing hash lookup.")
                file_hash = await hash_file(os.path.join(lora_folder, f"{lora_id}.safetensors"))  # Assuming safetensors format
                version_info = await fetch_version_info(session, file_hash)

                if not version_info:
                    return web.json_response({"status": "error", "message": "Could not refresh LoRA"}, status=400)
            else:
                version_info = await fetch_version_info_by_id(session, version_id)

            # Update info.json with refreshed data
            # (Code to update the info.json with new data)

            return web.json_response({"status": "success", "data": info_data})

        except Exception as e:
            logger.info(f"Error refreshing LoRA: {str(e)}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

@PromptServer.instance.routes.post("/lora_sidebar/update_info")
async def update_lora_info(request):
    try:
        data = await request.json()
        lora_id = data.get('id')
        field = data.get('field')
        value = data.get('value')
       
        if not all([lora_id, field]):
            return web.json_response({
                "status": "error",
                "message": "Missing required parameters"
            }, status=400)

        # Construct paths
        lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
        info_file_path = os.path.join(lora_folder, "info.json")
       
        if not os.path.exists(info_file_path):
            return web.json_response({
                "status": "error",
                "message": "LoRA info file not found"
            }, status=404)
       
        # Read current info
        with open(info_file_path, "r", encoding="utf-8") as f:
            info_data = json.load(f)
           
        # Initialize user_edits if it doesn't exist
        if 'user_edits' not in info_data:
            info_data['user_edits'] = []
           
        # Special handling for arrays/lists
        if isinstance(value, list) and field in ['tags', 'trained_words']:
            value = [str(item).strip() for item in value if str(item).strip()]
           
        # Update the field
        old_value = info_data.get(field)
        info_data[field] = value
           
        # Track the edit if it's not already in user_edits
        if field not in info_data['user_edits']:
            info_data['user_edits'].append(field)

        # Update in-memory cache before file write
        cache_updated = False
        if LORA_CACHE.get('ordered_loras'):
            for lora in LORA_CACHE['ordered_loras']:
                if lora['id'] == lora_id:
                    lora[field] = value
                    if 'user_edits' not in lora:
                        lora['user_edits'] = []
                    if field not in lora['user_edits']:
                        lora['user_edits'].append(field)
                    cache_updated = True
                    break

        # Save the updated info
        try:
            with open(info_file_path, "w", encoding="utf-8") as f:
                json.dump(info_data, f, indent=4, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Error saving info file: {str(e)}")
            if cache_updated:
                return web.json_response({
                    "status": "warning",
                    "message": "Changes saved to memory but not to disk. Changes may be lost on server restart.",
                    "field": field,
                    "old_value": old_value,
                    "new_value": value,
                    "user_edits": info_data['user_edits']
                })
            raise

        # Recalculate category info if needed
        category_info = None
        if field in ['tags', 'baseModel', 'subdir', 'favorite', 'nsfw']:
            category_info = manage_category_counts("calculate",
                loras=LORA_CACHE['ordered_loras']
            )
           
        # Prepare response data
        response_data = {
            "status": "success",
            "message": f"Updated {field} successfully",
            "field": field,
            "old_value": old_value,
            "new_value": value,
            "user_edits": info_data['user_edits']
        }
        
        if category_info:
            response_data["categoryInfo"] = category_info
       
        logger.info(f"Updated LoRA {lora_id} field '{field}': {old_value} -> {value}")
        return web.json_response(response_data)
       
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error updating LoRA info: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": "Invalid JSON data"
        }, status=400)
       
    except Exception as e:
        logger.error(f"Error updating LoRA info: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": f"Failed to update LoRA info: {str(e)}"
        }, status=500)
    
@PromptServer.instance.routes.get("/lora_sidebar/latest_temp_image")
async def get_latest_temp_image(request):
    temp_dir = folder_paths.get_temp_directory()
    
    try:
        # Get all png files in temp directory
        temp_files = [f for f in os.listdir(temp_dir) 
                     if f.endswith('.png') and os.path.isfile(os.path.join(temp_dir, f))]
        
        if not temp_files:
            return web.json_response({
                "status": "error",
                "message": "No generated images found"
            }, status=404)
            
        # Sort by modification time, newest first
        latest_file = max(temp_files, 
                         key=lambda f: os.path.getmtime(os.path.join(temp_dir, f)))
        
        # Construct full URL using request information
        host = request.headers.get('Host', 'localhost:8189')
        scheme = request.scheme
        
        # Format complete URL
        image_url = f"{scheme}://{host}/api/view?filename={latest_file}&type=temp"
        
        return web.json_response({
            "status": "success",
            "url": image_url
        })
        
    except Exception as e:
        logger.error(f"Error getting latest temp image: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)
    
@PromptServer.instance.routes.post("/lora_sidebar/upload_images")
async def upload_lora_images(request):
    try:
        # Check if we're getting a URL upload
        if request.content_type == 'application/json':
            data = await request.json()
            lora_id = data.get('lora_id')
            urls = data.get('urls', [])
            
            if not lora_id or not urls:
                return web.json_response({
                    "status": "error",
                    "message": "No valid URLs or LoRA ID provided"
                }, status=400)
            
            # Add duplicate check for temp images
            info_path = os.path.join(LORA_DATA_DIR, lora_id, "info.json")
            if os.path.exists(info_path):
                with open(info_path, 'r', encoding='utf-8') as f:
                    existing_data = json.load(f)
                    existing_sources = {img.get('source_url') for img in existing_data.get('images', []) 
                                     if img.get('source_url')}
                    # Only check the temp image URLs
                    temp_urls = [url for url in urls if 'type=temp' in url]
                    if any(url in existing_sources for url in temp_urls):
                        return web.json_response({
                            "status": "error",
                            "message": "Image already added to this LoRA"
                        }, status=400)
            
            images = []
            async with aiohttp.ClientSession() as session:
                for url in urls:
                    try:
                        # Validate URL
                        if not url.startswith(('http://', 'https://')):
                            continue
                            
                        # Download image
                        async with session.get(url) as response:
                            if response.status != 200:
                                continue
                                
                            # Get content type and file extension
                            content_type = response.headers.get('Content-Type', '')
                            if not content_type.startswith('image/'):
                                continue
                                
                            ext = mimetypes.guess_extension(content_type) or '.jpg'
                            
                            # Generate unique filename
                            filename = f"web_image_{int(time.time())}_{len(images)}{ext}"
                            
                            # Save the file
                            lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
                            os.makedirs(lora_folder, exist_ok=True)
                            
                            file_path = os.path.join(lora_folder, filename)
                            with open(file_path, 'wb') as f:
                                f.write(await response.read())
                                
                            images.append({
                                "url": f"/lora_sidebar/custom_image/{lora_id}/{filename}",
                                "type": "image",
                                "nsfwLevel": 0,
                                "hasMeta": True,
                                "custom": True,
                                "name": filename,
                                "source_url": url
                            })
                    except Exception as e:
                        logger.error(f"Error downloading image from {url}: {str(e)}")
                        continue
            
        else:
            # Handle multipart form data (existing local file upload code)
            reader = await request.multipart()
            lora_id = None
            images = []
            
            while True:
                part = await reader.next()
                if part is None:
                    break
                    
                if part.name == 'lora_id':
                    lora_id = (await part.read()).decode()
                elif part.name == 'files[]':
                    file_data = await part.read()
                    filename = part.filename
                    
                    if not filename:
                        continue
                        
                    if not filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                        continue
                    
                    lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
                    os.makedirs(lora_folder, exist_ok=True)
                    
                    file_path = os.path.join(lora_folder, filename)
                    with open(file_path, 'wb') as f:
                        f.write(file_data)
                        
                    images.append({
                        "url": f"/lora_sidebar/custom_image/{lora_id}/{filename}",
                        "type": "image",
                        "nsfwLevel": 0,
                        "hasMeta": True,
                        "custom": True,
                        "name": filename
                    })

        if not lora_id or not images:
            return web.json_response({
                "status": "error",
                "message": "No valid images or LoRA ID provided"
            }, status=400)
            
        # Update info.json with new images
        info_path = os.path.join(LORA_DATA_DIR, lora_id, "info.json")
        if os.path.exists(info_path):
            with open(info_path, 'r', encoding='utf-8') as f:
                info_data = json.load(f)
                
            # Preserve ALL existing images and add new ones
            existing_images = info_data.get('images', [])
            # Only filter out duplicates if they're custom images with the same name
            if images and existing_images:
                new_image_names = set(img['name'] for img in images if img.get('custom'))
                existing_images = [img for img in existing_images 
                                 if not (img.get('custom') and img.get('name') in new_image_names)]
            
            info_data['images'] = existing_images + images
            
            with open(info_path, 'w', encoding='utf-8') as f:
                json.dump(info_data, f, indent=4, ensure_ascii=False)
            
            return web.json_response({
                "status": "success",
                "message": f"Added {len(images)} images",
                "images": images
            })
            
    except Exception as e:
        logger.error(f"Error uploading images: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)
    
@PromptServer.instance.routes.post("/lora_sidebar/open_folder")
async def open_folder(request):
    try:
        data = await request.json()
        folder_path = data.get('path')
        
        if not folder_path or not os.path.exists(folder_path):
            return web.json_response({
                "status": "error",
                "message": "Invalid or non-existent path"
            }, status=400)

        try:
            # Windows
            if os.name == 'nt':
                os.startfile(folder_path)
            # macOS and Linux/Unix-like systems
            else:
                if sys.platform == 'darwin':  # macOS
                    subprocess.Popen(['open', folder_path])
                else:  # Linux/Unix
                    subprocess.Popen(['xdg-open', folder_path])
                
            return web.json_response({"status": "success"})
            
        except Exception as e:
            logger.error(f"Error opening folder: {str(e)}")
            return web.json_response({
                "status": "error",
                "message": str(e)
            }, status=500)
            
    except Exception as e:
        logger.error(f"Error processing request: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)
        
@PromptServer.instance.routes.post("/lora_sidebar/delete_lora")
async def delete_lora(request):
    data = await request.json()
    lora_id = data.get('id')
    
    if not lora_id:
        return web.json_response({"status": "error", "message": "No LoRA ID provided"}, status=400)
    
    lora_folder = os.path.join(LORA_DATA_DIR, lora_id)
    processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
    
    try:
        # Remove the LoRA folder
        if os.path.exists(lora_folder):
            shutil.rmtree(lora_folder)
        
        # Update processed_loras.json
        if os.path.exists(processed_loras_file):
            with open(processed_loras_file, 'r', encoding="utf-8") as f:
                processed_loras = json.load(f)
            
            # Remove from processed list using the new format
            if 'loras' in processed_loras:
                processed_loras['loras'] = [
                    lora for lora in processed_loras['loras'] 
                    if lora.get('filename') != lora_id
                ]
            
            if 'favorites' in processed_loras:
                processed_loras['favorites'] = [f for f in processed_loras['favorites'] if f != lora_id]
            
            # Write updated data back to file
            with open(processed_loras_file, 'w', encoding="utf-8") as f:
                json.dump(processed_loras, f, indent=4, ensure_ascii=False)
        
        logger.info(f"Successfully deleted LoRA: {lora_id}")
        return web.json_response({"status": "success", "message": f"LoRA {lora_id} deleted successfully"})
    
    except Exception as e:
        logger.error(f"Error deleting LoRA {lora_id}: {str(e)}")
        return web.json_response({"status": "error", "message": f"Failed to delete LoRA: {str(e)}"}, status=500)

@PromptServer.instance.routes.post("/lora_sidebar/set_version")
async def set_processed_version(request):
    try:
        # Get the version we should set (true = 1, false = current version)
        data = await request.json()
        use_old_version = data.get('use_old_version', False)
        
        processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
        
        # Initialize with default structure if file doesn't exist
        if not os.path.exists(processed_loras_file):
            processed_loras = {
                "version": PROCESSED_LORAS_VERSION if not use_old_version else 1,
                "loras": [],
                "favorites": []
            }
        else:
            # Read existing data
            with open(processed_loras_file, 'r', encoding='utf-8') as f:
                processed_loras = json.load(f)
                
            # Only update the version field
            processed_loras['version'] = 1 if use_old_version else PROCESSED_LORAS_VERSION
        
        # Write back the modified data
        with open(processed_loras_file, 'w', encoding='utf-8') as f:
            json.dump(processed_loras, f, indent=4, ensure_ascii=False)
        
        return web.json_response({
            "status": "success",
            "version": processed_loras['version']
        })
        
    except Exception as e:
        logger.error(f"Error setting processed version: {str(e)}")
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)
    
#####    
##### DATA REWRITE DANERGOUS STUFF #####
#####

def get_user_settings(request):
    """Get user settings using AppSettings."""
    try:
        # Get settings from app_settings using the user manager
        settings = PromptServer.instance.user_manager.settings.get_settings(request)
        
        return {
            'sortMethod': settings.get("LoRA Sidebar.General.sortMethod", 'AlphaAsc'),
            'sortModels': settings.get("LoRA Sidebar.General.sortModels", 'None'),
            'tagSource': settings.get("LoRA Sidebar.General.tagSource", 'CivitAI'),
            'customTags': settings.get("LoRA Sidebar.General.customTags", "").split(','),
            'catNew': settings.get("LoRA Sidebar.General.catNew", True),
            'nsfwFolder': settings.get("LoRA Sidebar.NSFW.nsfwFolder", True),
            'nsfwString': settings.get("LoRA Sidebar.NSFW.folderString", 'NSFW')
        }
    except Exception as e:
        logger.error(f"Error getting user settings: {str(e)}")
        # Fallback to defaults
        return {
            'sortMethod': 'AlphaAsc',
            'sortModels': 'None',
            'tagSource': 'CivitAI',
            'customTags': [],
            'catNew': True,
            'nsfwFolder': True,
            'nsfwString': 'NSFW'
        }

async def sort_loras_with_categories(loras, settings, favorites, sort_metadata):
    """
    Process loras with their real categories and status flags.
    """
    # Add default settings if missing
    settings = {
        'sortMethod': settings.get('sortMethod', 'AlphaAsc'),
        'sortModels': settings.get('sortModels', 'None'),
        'tagSource': settings.get('tagSource', 'CivitAI'),
        'customTags': settings.get('customTags', []),
        'catNew': settings.get('catNew', True),
        'nsfwFolder': settings.get('nsfwFolder', True),
        'nsfwString': settings.get('nsfwString', 'NSFW')
    }

    for lora in loras:
        # Set status flags
        lora['favorite'] = lora['id'] in favorites

        # auto data handling so people don't have to run updates on all their previous loras
        creation_date = None
        needs_update = False

        # Try metadata date first
        if lora.get('createdDate') and lora['createdDate'] != 'unknown':
            try:
                creation_date = datetime.strptime(lora['createdDate'], '%Y-%m-%d')
                # logger.debug(f"LoRA {lora.get('name', lora['id'])} using metadata date: {creation_date}")
            except ValueError:
                logger.debug(f"Invalid metadata date for {lora.get('name', lora['id'])}")
                creation_date = None
        
        # If no valid metadata date, try sort_metadata cache first as it's faster
        if not creation_date and sort_metadata and lora['id'] in sort_metadata:
            creation_date = datetime.fromtimestamp(sort_metadata[lora['id']]['ctime'])
            # logger.debug(f"Using sort_metadata date for {lora['id']}: {creation_date}")

        # If still no date, check LoRA folder creation time
        if not creation_date:
            lora_folder = os.path.join(LORA_DATA_DIR, lora['id'])
            try:
                folder_stat = os.stat(lora_folder)
                folder_date = datetime.fromtimestamp(folder_stat.st_ctime)
                creation_date = folder_date
                needs_update = True
                # logger.debug(f"Using folder creation date for {lora['id']}: {creation_date}")
            except Exception as e:
                logger.error(f"Error getting folder date for {lora['id']}: {str(e)}")

        # Update info.json if we found a folder date
        if needs_update and creation_date:
            info_path = os.path.join(LORA_DATA_DIR, lora['id'], "info.json")
            try:
                with open(info_path, 'r', encoding='utf-8') as f:
                    info_data = json.load(f)
                info_data['createdDate'] = creation_date.strftime('%Y-%m-%d')
                with open(info_path, 'w', encoding='utf-8') as f:
                    json.dump(info_data, f, indent=4, ensure_ascii=False)
                logger.info(f"Updated {lora['id']} info.json with folder date: {creation_date}")
            except Exception as e:
                logger.error(f"Error updating info.json date for {lora['id']}: {str(e)}")

        # Store final timestamp and calculate new status
        lora['created_time'] = creation_date.timestamp() if creation_date else FALLBACK_TIMESTAMP
        hours_ago = datetime.now() - timedelta(hours=NEW_ITEM_HOURS)
        lora['is_new'] = creation_date >= hours_ago if creation_date else False

        # Assign real category
        sort_models = settings.get('sortModels', 'All LoRAs')
        if sort_models == 'Tags':
            category = 'Unsorted'
            if lora.get('tags', []):
                for tag in get_tag_categories(settings):
                    if tag in lora['tags']:
                        category = tag
                        break
            lora['category'] = category
        elif sort_models == 'Subdir':
            lora['category'] = lora.get('subdir', '').split('\\')[-1] or 'Unsorted'
        else:
            lora['category'] = 'All LoRAs'

    # Define sort key function
    def sort_key(lora):
        if settings['sortMethod'] == 'AlphaAsc':
            name = lora.get('name') or lora.get('filename') or 'zzz'
            return name.lower()
        elif settings['sortMethod'] == 'AlphaDesc':
            name = lora.get('name') or lora.get('filename') or '___'
            return -ord(name[0].lower())
        elif settings['sortMethod'] == 'DateNewest':
            date_str = lora.get('createdDate', '1970-01-01')
            if date_str in ('unknown', '1970-01-01'):
                return FALLBACK_TIMESTAMP
            
            for fmt in DATE_FORMATS:
                try:
                    timestamp = datetime.strptime(date_str, fmt).timestamp()
                    return -timestamp
                except (ValueError, OSError):
                    continue
                    
            logger.error(f"Could not parse date for LoRA {lora.get('id', 'Unknown ID')}: {date_str}")
            return FALLBACK_TIMESTAMP
        else:  # DateOldest
            date_str = lora.get('createdDate', '1970-01-01')
            if date_str in ('unknown', '1970-01-01'):
                return -FALLBACK_TIMESTAMP
                
            for fmt in DATE_FORMATS:
                try: 
                    timestamp = datetime.strptime(date_str, fmt).timestamp()
                    return timestamp
                except (ValueError, OSError):
                    continue
                    
            logger.error(f"Could not parse date for LoRA {lora.get('id', 'Unknown ID')}: {date_str}")
            return -FALLBACK_TIMESTAMP

    # Sort based on settings
    loras = sorted(loras, key=sort_key)

    # Order items for initial data packet (favorites/new first)
    favorites_list = [lora for lora in loras if lora['favorite']]
    new_items = []
    if settings['catNew']:
        new_items = [
            lora for lora in loras 
            if not lora['favorite'] and lora['is_new']
        ]
    
    remaining_loras = [
        lora for lora in loras 
        if not lora['favorite'] and 
        (not lora['is_new'] or not settings['catNew'])
    ]

    return favorites_list + new_items + remaining_loras

def show_build_progress(current, total, prefix='\033[1;34m[LoRA Sidebar]:\033[0m Building LoRA cache', width=50):
    """
    Show a colorized progress bar with item count and percentage.
    """
    try:
        percent = float(current) * 100 / total
        filled = int(width * current / total)
        bar = (f"{ANSI_COLORS['CYAN']}{'█' * filled}"
               f"{ANSI_COLORS['BLUE']}{'▒' * (width - filled)}"
               f"{ANSI_COLORS['ENDC']}")
        
        status = (f"\r{ANSI_COLORS['BOLD']}{prefix}{ANSI_COLORS['ENDC']} "
                 f"|{bar}| "
                 f"{ANSI_COLORS['GREEN']}{percent:>5.1f}%{ANSI_COLORS['ENDC']} "
                 f"({current}/{total})")
        
        print(status, end='')
        if current == total:
            print(f"\n\033[1;34m[LoRA Sidebar]:\033[0m {ANSI_COLORS['GREEN']}Cache build complete!{ANSI_COLORS['ENDC']}")
            
    except Exception:
        # Fallback to basic progress in case of any issues with colors
        print(f"\rBuilding cache: {current}/{total}", end='')

async def build_initial_cache():
    """
    Build the initial LoRA cache on startup using processed_loras.json.
    """
    logger.info("Starting initial LoRA cache build...")
    start_time = datetime.now()
    total_loras = 0
    PLUGIN_PREFIX = "\033[1;34m[LoRA Sidebar]:\033[0m "
    
    try:
        # Load processed_loras.json first
        processed_loras_file = os.path.join(LORA_DATA_DIR, "processed_loras.json")
        if not os.path.exists(processed_loras_file):
            logger.warning("No processed_loras.json found - cache will be built on first /data request")
            print(f"\n{PLUGIN_PREFIX}{ANSI_COLORS['YELLOW']}{get_completion_message(0)}{ANSI_COLORS['ENDC']}")
            return

        with open(processed_loras_file, "r", encoding="utf-8") as f:
            try:
                processed_loras = json.load(f)
                if not isinstance(processed_loras, dict):
                    logger.warning("Invalid processed_loras.json format")
                    return
            except json.JSONDecodeError:
                logger.error("Error reading processed_loras.json")
                return

        # Get favorites list
        favorites = processed_loras.get('favorites', [])
        lora_entries = processed_loras.get('loras', [])
        
        if not lora_entries:
            logger.warning("No processed LoRAs found")
            print(f"\n{PLUGIN_PREFIX}{ANSI_COLORS['YELLOW']}{get_completion_message(0)}{ANSI_COLORS['ENDC']}")
            return

        total_loras = len(lora_entries)
        processed = 0
        lora_data = []

        # Process each LoRA from processed_loras.json
        for lora_entry in lora_entries:
            base_filename = lora_entry.get('filename')
            if not base_filename:
                continue

            info_file = os.path.join(LORA_DATA_DIR, base_filename, "info.json")
            if os.path.exists(info_file):
                with open(info_file, "r", encoding="utf-8") as f:
                    try:
                        data = json.load(f)
                        data['id'] = base_filename
                        data['favorite'] = base_filename in favorites
                        data['filename'] = base_filename
                        data['path'] = lora_entry.get('path', '')
                        lora_data.append(data)
                    except json.JSONDecodeError:
                        logger.error(f"Error reading {info_file}")

            processed += 1
            show_build_progress(processed, total_loras)

        # Sort and store in cache
        if lora_data:
            # Process NSFW folder flags before sorting
            if CACHE_SETTINGS.get('nsfwFolder', True):
                nsfw_string = CACHE_SETTINGS.get('nsfwString', 'NSFW').lower()
                logger.info(f"Setting NSFW string {nsfw_string}")
                for lora in lora_data:
                    if lora.get('path'):
                        path_lower = lora['path'].lower()
                        if nsfw_string and nsfw_string in path_lower:
                            logger.info(f"Checking NSFW path for {lora.get('name')}: {path_lower}")
                            # Check only the path components, excluding the filename
                            path_parts = os.path.dirname(path_lower).split(os.sep)
                            if any(nsfw_string in part for part in path_parts):
                                logger.info(f"Setting NSFW flag for {lora.get('name', 'Unknown')} due to path: {path_parts}")
                                lora['nsfw'] = True
                                lora['nsfwLevel'] = 100

            sort_metadata = await get_lora_sort_metadata()
            LORA_CACHE['ordered_loras'] = await sort_loras_with_categories(
                lora_data, CACHE_SETTINGS, favorites, sort_metadata
            )
            LORA_CACHE['sent_loras'] = set()  # Reset sent tracking
            
            # Calculate initial category counts
            manage_category_counts("calculate",
                loras=LORA_CACHE['ordered_loras'],
                settings=CACHE_SETTINGS
            )

        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        logger.info(f"LoRA cache built successfully in {duration:.2f} seconds")
        print(f"{PLUGIN_PREFIX}LoRA cache built in{ANSI_COLORS['CYAN']} {duration:.2f} seconds{ANSI_COLORS['ENDC']}")
        print(f"{PLUGIN_PREFIX}Total LoRAs processed:{ANSI_COLORS['BOLD']} {total_loras}{ANSI_COLORS['ENDC']}")
        print(f"{PLUGIN_PREFIX}{ANSI_COLORS['BOLD']}{ANSI_COLORS['YELLOW']}{get_completion_message(total_loras)}{ANSI_COLORS['ENDC']}\n")

    except Exception as e:
        logger.error(f"Error building initial cache: {str(e)}")
        print(f"\n{ANSI_COLORS['RED']}Error building cache: {str(e)}{ANSI_COLORS['ENDC']}")

@PromptServer.instance.routes.get("/lora_sidebar/category/{category_name}")
async def get_category_items(request):
    category_name = request.match_info['category_name']
    limit = int(request.query.get('limit', 500))
   
    if not LORA_CACHE['ordered_loras']:
        return web.json_response({"error": "No LoRA data loaded"}, status=400)
       
    # Get all items for this category
    category_items = [
        lora for lora in LORA_CACHE['ordered_loras']
        if lora['category'] == category_name and not lora.get('favorite', False) and not lora.get('is_new', False)
    ]

    # Check for any unsent items
    unsent_items = [
        lora for lora in category_items 
        if lora['id'] not in LORA_CACHE['sent_loras']
    ]

    # Get all category IDs
    category_ids = [lora['id'] for lora in category_items]

    response_data = {
        "category_ids": category_ids,
        "total": len(category_items)
    }

    # If we found any unsent items, include them too
    if unsent_items:
        items_to_send = unsent_items[:limit]
        LORA_CACHE['sent_loras'].update(lora['id'] for lora in items_to_send)
        response_data["items"] = items_to_send
        response_data["hasMore"] = len(unsent_items) > len(items_to_send)
        print(f"Category {category_name}: Found {len(items_to_send)} unsent items")

    return web.json_response(response_data)

##### Initial loading stuff

print(f"\n\033[1;34m[LoRA Sidebar]:\033[0m Starting initial cache build...")

# Create and run a new event loop to execute our async cache builder
try:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(build_initial_cache())
    loop.close()
except Exception as e:
    print(f"\033[91m[LoRA Sidebar]: Error building cache: {str(e)}\033[0m")



NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]