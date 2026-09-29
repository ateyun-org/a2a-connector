export async function listenWithNextPort(server, startPort, attempts = 20) {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535 ||
      !Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Invalid DSH adapter port range');
  }
  const limit = Math.min(attempts, 65536 - startPort);
  for (let offset = 0; offset < limit; offset++) {
    const port = startPort + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || offset === limit - 1) throw error;
    }
  }
  throw new Error('No available DSH adapter port');
}
