FROM onlyoffice/documentserver:latest AS ds-templates

FROM python:3.11-slim

WORKDIR /app
COPY --from=ds-templates \
    /var/www/onlyoffice/documentserver/document-templates/new/default/new.docx \
    /var/www/onlyoffice/documentserver/document-templates/new/default/new.xlsx \
    /var/www/onlyoffice/documentserver/document-templates/new/default/new.pptx \
    /app/templates/
COPY server.py editor.html /app/

ENV DIRECT_CONNECTOR_HOST=0.0.0.0
ENV DIRECT_CONNECTOR_PORT=8000

EXPOSE 8000

CMD ["python", "/app/server.py"]
