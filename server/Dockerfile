# 运行镜像只含服务端。在 Mac 上构建，在 NAS 上运行。
# 构建上下文是 server/：docker build -f Dockerfile .

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
WORKDIR /app
# corepack 会把 `prepare` 的下载目标硬编码成 registry.npmjs.org，
# 在国内网络（或只放行镜像源的构建环境）里必然失败。必须显式指向可达的 registry。
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
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
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 同上：corepack 的下载源不受 `pnpm config` 影响，必须单独指定。
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
RUN pnpm config set registry "$NPM_REGISTRY"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY src/server/public ./src/server/public
COPY templates ./templates
EXPOSE 3000
CMD ["node", "dist/cli/index.js", "start"]
