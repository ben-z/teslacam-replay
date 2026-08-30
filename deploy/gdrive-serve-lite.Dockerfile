# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/gdrive-serve-lite \
    ./cmd/gdrive-serve-lite

FROM gcr.io/distroless/static-debian12:nonroot

ARG SOURCE_SHA=dev
LABEL org.opencontainers.image.revision=$SOURCE_SHA
COPY --from=build /out/gdrive-serve-lite /gdrive-serve-lite
ENTRYPOINT ["/gdrive-serve-lite"]
