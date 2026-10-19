FROM node:20-alpine

WORKDIR /app

# Instala so as dependencias primeiro (cache de build)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copia o codigo
COPY server.js test-client.js ./
COPY lib ./lib
COPY public ./public

# Os videos recebidos e a config ficam em /app/data (volume). O dono e o
# usuario "apps" do TrueNAS (568): um volume nomeado novo herda esse dono.
RUN mkdir -p /app/data/uploads && chown -R 568:568 /app/data
VOLUME ["/app/data"]

ENV PORT=3000 NODE_ENV=production LIBRARY_DIR=/library
EXPOSE 3000
USER 568:568

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
