FROM node:24-alpine
WORKDIR /app
COPY package.json server.js reset-password.js ./
COPY public ./public
ENV DB_PATH=/app/data/solves.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
