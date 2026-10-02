/** What the hub accepts as a loop image: uploaded from the console, or read from a Git repository. */
export const MAX_UPLOAD_BYTES = 2.5 * 1024 * 1024

export const UPLOAD_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const

/**
 * Whether the bytes are the image they claim to be — by their first bytes.
 *
 * Not a validation of the image: a check that a PDF or a zip renamed `.png`
 * does not end up on the room screens as a broken frame.
 */
export function looksLike(contentType: keyof typeof UPLOAD_EXTENSIONS, bytes: Buffer): boolean {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  switch (contentType) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff)
    case 'image/gif':
      return bytes.subarray(0, 4).toString('latin1') === 'GIF8'
    case 'image/webp':
      return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
    case 'image/svg+xml': {
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart()
      return text.startsWith('<') && text.includes('<svg')
    }
  }
}
