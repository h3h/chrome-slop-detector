// code: 'auth' | 'provider_rate_limit' | 'bad_response' | 'network' | 'timeout'
export class ProviderError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'ProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
