FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --production

FROM node:20-alpine AS runtime

WORKDIR /app

RUN addgroup -S a2a && adduser -S -G a2a a2a

COPY --from=builder --chown=a2a:a2a /app/package.json ./package.json
COPY --from=builder --chown=a2a:a2a /app/node_modules ./node_modules
COPY --from=builder --chown=a2a:a2a /app/dist ./dist

USER a2a

EXPOSE 3000

CMD ["node", "dist/server.js"]
