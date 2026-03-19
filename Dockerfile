FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PEPAGI_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3099
CMD ["node", "dist/daemon.js"]
