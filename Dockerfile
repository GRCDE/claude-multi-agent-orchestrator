# Multi-Agent Orchestrator – Docker Image
# Minimales Node.js-Image mit Non-Root User für Sicherheit

FROM node:20-slim

# Non-Root User erstellen
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# Abhängigkeiten zuerst kopieren (Docker Layer-Cache nutzen)
COPY package*.json ./
RUN npm ci --production

# Restlichen Quellcode kopieren
COPY . .

# Projektverzeichnis erstellen und Rechte setzen
RUN mkdir -p /app/projects && chown -R appuser:appuser /app

# Als Non-Root User ausführen
USER appuser

EXPOSE 3131

ENV NODE_ENV=production

CMD ["node", "server.js"]
