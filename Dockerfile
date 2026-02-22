FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server

ENV NODE_ENV=production
ENV SERVE_FRONTEND=true
EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "server/index.ts"]
