# Arra pricer API: GET /health, GET /events, POST /quote.
#   docker build -t arra-pricer offchain && docker run -p 8787:8787 --env-file offchain/.env arra-pricer
# Secrets (OPERATOR_PRIVATE_KEY) come from the host's secret store at runtime, never the image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY abi ./abi
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/pricer.js"]
