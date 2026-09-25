FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY app.js ./app.js
COPY data/unresolved_parts.json ./data/unresolved_parts.json
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm","start"]
