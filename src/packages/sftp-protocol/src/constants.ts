export const SFTP_VERSION = 3;

/** Refuse any declared packet length beyond this before allocating for it. */
export const DEFAULT_MAX_PACKET_LENGTH = 16 * 1024 * 1024;

export const PacketType = {
  Init: 1,
  Version: 2,
  Open: 3,
  Close: 4,
  Read: 5,
  Write: 6,
  Lstat: 7,
  Fstat: 8,
  Setstat: 9,
  Fsetstat: 10,
  Opendir: 11,
  Readdir: 12,
  Remove: 13,
  Mkdir: 14,
  Rmdir: 15,
  Realpath: 16,
  Stat: 17,
  Rename: 18,
  Readlink: 19,
  Symlink: 20,
  Status: 101,
  Handle: 102,
  Data: 103,
  Name: 104,
  Attrs: 105,
  Extended: 200,
  ExtendedReply: 201
} as const;

export type PacketTypeValue = (typeof PacketType)[keyof typeof PacketType];

export const AttributeFlag = {
  Size: 0x00000001,
  UidGid: 0x00000002,
  Permissions: 0x00000004,
  AccessModifyTime: 0x00000008,
  Extended: 0x80000000
} as const;

/** SSH_FXF_* flags for SSH_FXP_OPEN. */
export const OpenFlag = {
  Read: 0x00000001,
  Write: 0x00000002,
  Append: 0x00000004,
  Creat: 0x00000008,
  Trunc: 0x00000010,
  Excl: 0x00000020
} as const;

/** POSIX file-type bits carried in the permissions attribute. */
export const FileTypeMask = 0o170000;
export const FileTypeBits = {
  Directory: 0o040000,
  Regular: 0o100000,
  Symlink: 0o120000
} as const;

/** OpenSSH protocol extensions we probe for. */
export const Extension = {
  PosixRename: 'posix-rename@openssh.com',
  Fsync: 'fsync@openssh.com',
  Limits: 'limits@openssh.com',
  Statvfs: 'statvfs@openssh.com',
  Hardlink: 'hardlink@openssh.com'
} as const;
