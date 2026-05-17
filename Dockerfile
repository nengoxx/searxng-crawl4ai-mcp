FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose port for MCP server
EXPOSE 3003

# Start the MCP server
CMD ["npm", "start"]
