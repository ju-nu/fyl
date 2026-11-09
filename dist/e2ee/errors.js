// Client-side error codes of docs/E2EE.md §13, plus the few the clients add around them. Messages never contain
// input, so no key, name or link ends up in an error report.
const MESSAGES = {
  key_invalid: 'This key is incomplete or damaged.',
  key_wrong: "This key doesn't open this file. Check that you copied the whole link.",
  mode_mismatch: "This link has a key, but the file isn't encrypted.",
  unsupported: 'This file needs a newer fyl.',
  corrupt: "The file is damaged or was changed. It can't be decrypted safely.",
  truncated: 'The file is incomplete.',
  trailing_data: "The file is damaged or was changed. It can't be decrypted safely.",
  network: 'Download interrupted. Try again.',
  other_transfer: 'This link is for another file.',
  link_invalid: 'This is not a fyl.at link.',
  url_mismatch: 'fyl.at answered with an unexpected link, so none was shown. Please try again later.',
  file_changed: 'The file changed since this upload started. Start a new upload.',
  platform: "This browser can't encrypt or decrypt files. Update it, or use the fyl tool.",
};

export class E2EEError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = 'E2EEError';
    this.code = code;
  }
}
