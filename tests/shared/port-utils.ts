import * as net from "node:net";

/**
 * Finds a free port by binding to port 0 and returning the assigned port.
 * Note: To avoid race conditions, it's often better to let the server itself
 * bind to port 0 directly. This utility is provided for cases where the port
 * must be known before starting the target server.
 */
export const findFreePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
};
