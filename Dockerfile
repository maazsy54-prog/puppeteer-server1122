
FROM ghcr.io/puppeteer/puppeteer:24.15.0

# Set working directory
WORKDIR /app

# Copy package files as root
USER root
COPY package*.json ./

# Fix ownership so pptruser can write
RUN chown -R pptruser:pptruser /app

# Switch back to non-root user
USER pptruser

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of the app
COPY --chown=pptruser:pptruser . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]



