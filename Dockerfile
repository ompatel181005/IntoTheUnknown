# One container: FastAPI serves /api, /frames and the built React app (Azure Container Apps).
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
COPY backend/ backend/
RUN pip install --no-cache-dir -e ./backend
COPY demo/ demo/
COPY --from=web /web/dist frontend/dist
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
