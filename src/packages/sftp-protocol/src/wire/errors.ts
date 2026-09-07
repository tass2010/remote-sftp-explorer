/**
 * The packet stream violated the SFTP framing or packet grammar. Not recoverable:
 * once the byte stream is out of sync there is no way back, so the session dies.
 */
export class SftpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpProtocolError';
  }
}
