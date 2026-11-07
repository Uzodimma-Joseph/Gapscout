FROM node:22-slim
WORKDIR /app
COPY . .
RUN mkdir -p /data
ENV DB_FILE=/data/gapscout.db PORT=3000
CMD ["npm", "start"]
