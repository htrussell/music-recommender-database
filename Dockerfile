FROM python:3.11-slim

WORKDIR /app

# Install the Parquet reader and Postgres adapter
RUN pip install --no-cache-dir duckdb==1.2.2 psycopg2-binary httpx==0.28.1

# Copy ingestion and embedding scripts into the container
COPY load_postgres.py embed_catalog.py ./

# Run the script by default
CMD ["python", "load_postgres.py"]