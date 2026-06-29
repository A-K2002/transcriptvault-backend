FROM node:20-slim

# Install Python, ffmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Install Node dependencies
COPY package.json .
RUN npm install

# Copy server code
COPY server.js .

# Expose port
EXPOSE 3000

CMD ["node", "server.js"]
