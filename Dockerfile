FROM python:3.11-slim

WORKDIR /app

# Install the Postgres adapter
RUN pip install --no-cache-dir psycopg2-binary

# Copy the ingestion script into the container
COPY load_postgres.py .

# Run the script by default
CMD ["python", "load_postgres.py"]