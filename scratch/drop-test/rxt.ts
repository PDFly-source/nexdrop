/**
 * Local drop-resume drill harness (scratch only — not shipped):
 * starts a Turbo receiver that prints session/port/token, auto-accepts.
 */
import { newSessionToken } from '../../companion/src/handshake';
import { TurboTcpServer } from '../../companion/src/tcpTransport';

const { token, tokenBytes, sessionId } = newSessionToken();
const server = new TurboTcpServer();
server.acceptHandler = async (m) => ({
  accept: true,
  targetPath: process.cwd() + '/scratch/drop-test/rx/' + m.name,
});
server.on('verified', (r) => {
  console.log(`VERIFIED ${r.integrity} ${r.sha256}`);
  process.exit(r.integrity === 'pass' ? 0 : 2);
});
server.listen(0, tokenBytes, sessionId).then((port) => {
  console.log(`session ${sessionId} port ${port} token ${token}`);
});
