FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
ARG SOURCE_SHA=dev
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server

ENV NODE_ENV=production
ENV SERVE_FRONTEND=true
ENV APP_VERSION=$SOURCE_SHA
LABEL org.opencontainers.image.revision=$SOURCE_SHA
EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "server/index.ts"]
