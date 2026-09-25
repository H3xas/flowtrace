const request = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then((response) => {
    if (!response.ok) throw new Error(`${method} ${url} answered ${response.status}`);
    return response.json();
  });

const gateway = {
  get: (url: string) => request('GET', url),
  post: (url: string, body: unknown) => request('POST', url, body),
  put: (url: string, body: unknown) => request('PUT', url, body),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
