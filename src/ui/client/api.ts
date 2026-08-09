export const apiClientScript = `
  window.GlobalRegistryUi = window.GlobalRegistryUi || {};
  window.GlobalRegistryUi.request = async (path, options) => {
    const response = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }, options || {}));
    const contentType = response.headers.get('content-type') || '';
    const payload = response.status === 204
      ? null
      : (contentType.includes('application/json') ? await response.json() : null);
    if (!response.ok) {
      const error = new Error(
        payload && payload.error && payload.error.message
          ? payload.error.message
          : 'リクエストに失敗しました（HTTP ' + response.status + '）。'
      );
      error.status = response.status;
      error.code = payload && payload.error ? payload.error.code : 'http_error';
      error.violations = payload && payload.error ? payload.error.violations : undefined;
      error.requestId = payload ? payload.requestId : undefined;
      throw error;
    }
    return payload;
  };
`;
