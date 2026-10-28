FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/index.js"]
