import { vi } from 'vitest';

import {
  AbstractObservationExtractor,
  ObservationEntity,
} from '@rosen-bridge/abstract-observation-extractor';
import { Repository } from '@rosen-bridge/extended-typeorm';

/** Persist repaired raw data and return the configured extractor identity. */
export const createMockObservationExtractor = (
  repository: Repository<ObservationEntity>,
) => {
  return {
    processTransactions: vi.fn(async (observations: ObservationEntity[]) => {
      for (const observation of observations)
        await repository.update(observation.id, { rawData: 'replayed' });
      return true;
    }),
    getId: () => 'extractor',
  } as unknown as AbstractObservationExtractor<ObservationEntity>;
};
