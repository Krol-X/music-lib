FROM oven/bun:1.4 AS base
WORKDIR /app

# Устанавливаем ffmpeg для конвертации и проверки аудио
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV MUSICLIB_HOST=0.0.0.0
ENV MUSICLIB_PORT=3000
ENV MUSICLIB_STORAGE=/app/storage
ENV MUSICLIB_PUSH=none

EXPOSE 3000
VOLUME ["/app/storage"]

CMD ["bun", "run", "src/index.ts"]
