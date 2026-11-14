# One container serves the page, the demo pack and the IRSA/VizieR/CDS proxy (Azure Container Apps).
FROM python:3.11-slim
WORKDIR /app
COPY server.py index.html ./
COPY demo ./demo
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
