FROM node:22-bookworm-slim
WORKDIR /opt/workbuddy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY *.js ./
COPY vendor ./vendor
COPY skills ./skills
RUN mkdir -p /data && chown node:node /data
ENV A2A_HOSTED_STATE_DIR=/data
USER node
ENTRYPOINT ["node", "/opt/workbuddy/hosted.js"]
CMD ["serve"]
