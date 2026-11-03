import { afterEach } from 'vitest';
import { closeAll } from './helpers';

afterEach(async () => {
  await closeAll();
});
