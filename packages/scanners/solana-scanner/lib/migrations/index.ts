import { migration1790730000000 } from './sqlite/1790730000000-migration';

export { migration1790730000000 };

export const migrations = {
  sqlite: [migration1790730000000],
};
