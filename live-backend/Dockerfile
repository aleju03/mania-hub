# Dev/trial artifact only. Production does NOT run this image: the VPS runs
# node 22 on glibc under two systemd units (see README "Production (VPS)").
# This file is Alpine/musl, and reading it as production has already cost one
# debugging session chasing a musl-vs-glibc difference that does not exist.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
EXPOSE 7227
CMD ["npm", "run", "start"]
