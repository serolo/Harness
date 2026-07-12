// Git-related DTOs that cross the IPC boundary.

/** A local SSH identity discovered from ~/.ssh or configured Git/OpenSSH files. */
export interface GitSshKey {
  /** Path to the private identity file. The private file contents are never read. */
  path: string;
  /** Public key path when a matching .pub file exists. */
  publicKeyPath?: string;
  /** Public key type, e.g. ssh-ed25519 or ssh-rsa. */
  type?: string;
  /** SHA256 fingerprint derived from the public key blob. */
  fingerprint?: string;
  /** Public key comment, commonly an email or hostname. */
  comment?: string;
  /** Where this identity was discovered. */
  source: 'ssh-dir' | 'gitconfig' | 'ssh-config';
}
