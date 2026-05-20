FROM python:3.11-slim

WORKDIR /app
COPY server.py editor.html /app/

ENV DIRECT_CONNECTOR_HOST=0.0.0.0
ENV DIRECT_CONNECTOR_PORT=8000

EXPOSE 8000

CMD ["python", "/app/server.py"]
