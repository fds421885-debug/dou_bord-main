FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --include=dev --legacy-peer-deps

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV DISABLE_HMR=true

EXPOSE 3000

CMD ["node", "server.ts"]
