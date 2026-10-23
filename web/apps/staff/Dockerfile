# HMS 2.0 staff console — build the SPA, serve it with nginx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:portal

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/dist-portal /usr/share/nginx/html/portal
EXPOSE 80
