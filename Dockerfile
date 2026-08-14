FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for numpy/pandas/sklearn
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements-lite.txt .
RUN pip install --no-cache-dir -r requirements-lite.txt

COPY backend/ .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
