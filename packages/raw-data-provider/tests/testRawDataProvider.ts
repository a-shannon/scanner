import { ObservationEntity } from '@rosen-bridge/abstract-observation-extractor';

import { AbstractRawDataProvider } from '../lib/abstractRawDataProvider';

/** Replay observations directly without fetching external transactions. */
export class TestRawDataProvider extends AbstractRawDataProvider<ObservationEntity> {
  /** Return the selected observation as a synthetic replay transaction. */
  fetchObservationTxs = async (
    observation: ObservationEntity,
  ): Promise<ObservationEntity[] | undefined> => [observation];
}
