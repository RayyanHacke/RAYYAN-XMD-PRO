FROM node:20-bullseye
RUN apt-get update && apt-get install -y ffmpeg python3 curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000 7860
ENV PORT=7860
CMD ["node", "index.js"]
