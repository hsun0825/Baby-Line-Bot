FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV DATABASE_PATH=/data/baby.db PORT=8000
VOLUME ["/data"]
CMD gunicorn app:app --bind 0.0.0.0:${PORT} --workers 1 --threads 4
