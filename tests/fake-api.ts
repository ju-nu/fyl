import { vi } from 'vitest';

// The window.FylAPI that dist/app.js uploads through (dist/api.js in the browser), as tests/web-app.test.ts scripts it.
// Each test sets what upload() does; the owner routes answer as the Worker would for the transfer R.
const R = 'r'.repeat(43);
export type Session = { uploadId: string; key: string; url: string };
export type Upload = (file: File, options: object, controller: AbortController, progress: unknown, resume: Session | null,
  onSession: (session: Session) => Promise<void>) => Promise<unknown>;
export const fakeAPI = () => ({
  validPassword: () => true, passphrase: () => 'tide-lamp-fern-41',
  info: vi.fn<(id: string, key: string) => Promise<unknown>>(),
  remove: vi.fn<(id: string, key: string) => Promise<unknown>>(async () => ({ deleted: true })),
  expiry: vi.fn<(id: string, key: string, minutes: number) => Promise<unknown>>(),
  unpause: vi.fn<(id: string, key: string) => Promise<unknown>>(async () => ({ id: R, owner: true, protected: true,
    passwordPause: { until: null, networks: 0 } })),
  discard: vi.fn<(session: object) => Promise<void>>(async () => {}),
  upload: vi.fn<Upload>(),
  crcPass: vi.fn<(files: Blob[], signal: AbortSignal, progress: (read: number) => void) => Promise<number[]>>(async files => files.map(() => 0)),
});
