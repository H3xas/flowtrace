const gateway = {
  post: (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) }),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
