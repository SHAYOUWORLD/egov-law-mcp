FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin

RUN chmod +x bin/egov-law-mcp.mjs

ENTRYPOINT ["node", "bin/egov-law-mcp.mjs"]
