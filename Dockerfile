# ServerDash — productie-image
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY agent ./agent
COPY scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8080
VOLUME ["/app/data"]

# Controleert alleen of het proces antwoordt. /api/health zelf geeft 503 als agents geen data sturen;
# dat is een melding waard, maar geen reden om de container als kapot te markeren.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(()=>process.exit(0),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
