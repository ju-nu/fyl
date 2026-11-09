// Dedicated module worker of the E2EE pages: builds upload parts and decrypts downloads off the page's thread
// (docs/E2EE.md §7, §9.2). See jobs.js.
import { serve } from './jobs.js';

serve(self);
