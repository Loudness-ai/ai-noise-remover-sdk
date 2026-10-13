FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY models ./models
COPY LICENSE NOTICE ./
COPY demo ./demo
RUN cd demo && npm ci --ignore-scripts --omit=dev --no-audit --no-fund
USER node
ENV HOST=0.0.0.0 PORT=7860
EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "demo/server.cjs"]
