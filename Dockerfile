FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "--enable-source-maps", "server-dist/index.js"]
