import os
import subprocess
import zipfile

def download_and_extract():
    """Downloads Kaggle datasets and extracts only the CSV files."""
    datasets = {
        "albums": "kauvinlucas/30000-albums-aggregated-review-ratings",
        "spotify": "priyamchoksi/spotify-dataset-114k-songs",
        "habits": "uditjain13/music-streaming-habits-2026",
        "artists": "pieca111/music-artists-popularity"
    }
    
    print("Starting Kaggle dataset downloads...")
    
    for key, ds in datasets.items():
        print(f"\nDownloading {key} dataset ({ds})...")
        # Download the zip file
        subprocess.run(["kaggle", "datasets", "download", "-d", ds, "-p", "."], check=True)
        
        # Kaggle names the downloaded zip file after the dataset name
        zip_name = f"{ds.split('/')[1]}.zip"
        
        # Extract the CSV files from the downloaded zip
        try:
            with zipfile.ZipFile(zip_name, 'r') as z:
                csv_files = [f for f in z.namelist() if f.endswith('.csv')]
                if csv_files:
                    for csv in csv_files:
                        z.extract(csv, path=".")
                        print(f" -> Extracted: {csv}")
                else:
                    print(f" -> WARNING: No CSV found in {zip_name}")
                    
            # Clean up the zip file
            os.remove(zip_name)
            print(f" -> Cleaned up archive: {zip_name}")
            
        except FileNotFoundError:
            print(f" -> ERROR: Failed to find {zip_name} after download.")

if __name__ == "__main__":
    download_and_extract()
    print("\nAll raw CSVs successfully downloaded and extracted.")