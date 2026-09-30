FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "src/server.js"]
