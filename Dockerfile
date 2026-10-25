FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080 TRADING_MODE=paper STARTING_BALANCE_USD=500
EXPOSE 8080
CMD ["npm","start"]