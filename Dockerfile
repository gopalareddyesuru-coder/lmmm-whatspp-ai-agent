FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY app.js ./app.js
COPY data/unresolved_parts.json ./data/unresolved_parts.json
COPY data/equipment_master.json ./data/equipment_master.json
COPY data/drawings_source_full.json ./data/drawings_source_full.json
COPY data/jobs.json ./data/jobs.json
COPY data/maintenance_history.json ./data/maintenance_history.json
COPY data/defects.json ./data/defects.json
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm","start"]
