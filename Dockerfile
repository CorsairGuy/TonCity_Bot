FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata

# Main bot dependencies
COPY package.json ./
RUN npm install

# React client build
COPY src/web/client/package.json ./src/web/client/
RUN cd src/web/client && npm install

COPY . .

# Build React client → src/web/dist/
RUN cd src/web/client && npm run build

RUN mkdir -p logs config
CMD ["node", "--max-old-space-size=3072", "src/index.js"]
