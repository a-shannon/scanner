import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';
import { Repository } from '@rosen-bridge/extended-typeorm';

import { mockObservationData } from './mocks/abstractRawDataProvider.mock';

/**
 * Store a synthetic observation for the selected height and request ID.
 */
export const insertObservation = async (
  repository: Repository<ObservationEntity>,
  height = 10,
  requestId = 'request',
) =>
  repository.save({
    ...mockObservationData.storedEntities[0],
    fromChain: 'ergo',
    extractor: 'extractor',
    height,
    requestId,
    sourceTxId: requestId,
  });
