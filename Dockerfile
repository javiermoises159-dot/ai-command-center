# One container serves the API and the built web app (same origin, no CORS).
FROM node:22-slim
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
# ffmpeg builds the vertical videos of the content calendar; the font is for the captions.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Dev dependencies are needed to build; NODE_ENV=production is set only for runtime below.
RUN NODE_ENV=development pnpm install --frozen-lockfile && pnpm build
EXPOSE 3001
ENV PORT=3001
CMD ["node", "apps/server/dist/main.js"]
