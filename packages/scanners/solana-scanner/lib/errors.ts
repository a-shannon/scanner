export class SolanaScannerFault extends Error {
  /** Create a scanner fault with its code and optional originating RPC details. */
  constructor(
    readonly code: string,
    readonly rpcMethod?: string,
    readonly rpcCode?: number,
  ) {
    super(code);
    this.name = 'SolanaScannerFault';
  }
}

/** Transport and endpoint failures leave the saved scan state unchanged. */
export class SolanaRpcUnavailableError extends Error {
  /** Create an availability error with its stable code and optional RPC metadata. */
  constructor(
    readonly code: string,
    readonly rpcMethod?: string,
    readonly rpcCode?: number,
  ) {
    super(code);
    this.name = 'SolanaRpcUnavailableError';
  }
}

export class SolanaStoreFault extends Error {
  /** Create a store fault with its stable code and classified storage kind. */
  constructor(
    readonly code: string,
    readonly kind: 'conflict' | 'content' | 'unavailable' | 'identity',
  ) {
    super(code);
    this.name = 'SolanaStoreFault';
  }
}
