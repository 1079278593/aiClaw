# 运行镜像只含服务端。在 Mac 上构建，在 NAS 上运行。
# 构建上下文是 server/：docker build -f Dockerfile .

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN pnpm config set registry "$NPM_REGISTRY"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
WORKDIR /app
ENV NODE_ENV=production
ARG AICLAW_BUILD=dev
ARG AICLAW_COMMIT=
ENV AICLAW_BUILD=${AICLAW_BUILD}
ENV AICLAW_COMMIT=${AICLAW_COMMIT}
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN pnpm config set registry "$NPM_REGISTRY"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY src/server/public ./src/server/public
COPY templates ./templates
EXPOSE 3000
CMD ["node", "dist/cli/index.js", "start"]
