FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY queue.js bot.js ./
ENV DATA_DIR=/data
VOLUME /data
CMD ["node", "bot.js"]
