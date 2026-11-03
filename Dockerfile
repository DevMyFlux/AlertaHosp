# Imagem do Cloud Run (API + painel no mesmo processo). As dependências de
# desenvolvimento ficam na imagem para os jobs (npm run db:migrate, scripts/*.ts com tsx).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["npm", "start"]
