# Multi-Agent Orchestrator – Docker Image
# Leichtgewichtiges Alpine-Image, kein Build-Step nötig
#
# HINWEIS: Die Claude Code CLI ist im Container NICHT verfügbar.
# Der Container eignet sich zum Testen des Web-Servers und der API,
# aber die eigentliche Agent-Orchestrierung benötigt eine lokale
# Installation mit Zugriff auf die Claude CLI.

FROM node:20-alpine

WORKDIR /app

# Abhängigkeiten zuerst kopieren (Docker Layer-Cache nutzen)
COPY package*.json ./
RUN npm ci --only=production

# Restlichen Quellcode kopieren
COPY . .

# Projektverzeichnis erstellen
RUN mkdir -p /app/projects

EXPOSE 3131

ENV NODE_ENV=production

CMD ["node", "server.js"]
