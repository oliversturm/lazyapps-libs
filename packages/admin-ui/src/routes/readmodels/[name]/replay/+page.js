export const load = ({ params, url }) => ({
  name: params.name,
  service: url.searchParams.get('service'),
  endpointName: url.searchParams.get('endpointName'),
});
