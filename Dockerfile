FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HTTP_PORT=3080
ENV HTTPS_PORT=3443

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data /app/certs

EXPOSE 3080 3443

CMD ["node", "server.js"]
