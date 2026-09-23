FROM node:22-bookworm-slim

# Native readers required by LMMM ingestion.
# mdbtools provides mdb-tables / mdb-export for .mdb and .accdb.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mdbtools \
      ca-certificates \
 && command -v mdb-tables \
 && command -v mdb-export \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "app.js"]
