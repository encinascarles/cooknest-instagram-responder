# Node.js 22 LTS Alpine (Node 18 is end of life)
FROM node:22-alpine

# Install curl for health check
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy all source files
COPY src ./src

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "src/server.js"]