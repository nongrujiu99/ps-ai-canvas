'use strict';

const { createServer } = require('./server');
const { createCredentialStore } = require('./credential-store');
const { createJobManager } = require('./jobs');
const { createAliyunProvider } = require('./providers/aliyun');
const { loadClientToken } = require('./client-token');

function createRuntime({ credentialStore = createCredentialStore(), providerFactory = createAliyunProvider, allowedOrigins = ['null'], clientToken = loadClientToken() } = {}) {
  const jobManager = createJobManager({
    providerFactory: async () => {
      const settings = await credentialStore.read();
      if (!settings || !settings.apiKey || !settings.workspaceId) throw new Error('missing settings');
      return providerFactory({
        endpoint: `https://${settings.workspaceId}.cn-beijing.maas.aliyuncs.com`,
        apiKey: settings.apiKey,
      });
    },
  });
  return createServer({ jobManager, credentialStore, allowedOrigins, clientToken });
}

function start() {
  const port = Number(process.env.PSAI_PORT || 32145);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PSAI_PORT');
  const clientToken = loadClientToken();
  const server = createRuntime({ clientToken });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`PS AI local service ready on 127.0.0.1:${port}\n`);
    process.stdout.write(`Local connection code: ${clientToken}\n`);
  });
  server.on('error', () => { process.stderr.write('PS AI local service could not start.\n'); process.exitCode = 1; });
  return server;
}

if (require.main === module) start();

module.exports = { createRuntime, start };
