FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY server.js prober.js ingest.js ./
COPY public/ public/

RUN mkdir -p data
VOLUME /app/data

EXPOSE 3000

CMD ["node", "server.js"]
